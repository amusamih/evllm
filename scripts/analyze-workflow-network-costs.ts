import { readFile, writeFile } from "node:fs/promises";

import { config as loadEnvironment } from "dotenv";
import {
  Contract,
  JsonRpcProvider,
  Transaction,
  formatEther,
  type TransactionResponse,
} from "ethers";

loadEnvironment({ path: ".env/local.env", quiet: true });

const workflowPath = "evaluation/final/assurance/deployment/sepolia-full-workflow.json";
const outputPath = "evaluation/final/assurance/deployment/cross-network-cost-snapshot.json";

const workflow = JSON.parse(await readFile(workflowPath, "utf8")) as {
  chain_id: string;
  transactions: Array<{
    transaction_hash: string;
    gas_used: string;
    transaction_fee_wei: string;
  }>;
  measurements: {
    confirmed_transaction_count: number;
    total_gas_used: string;
    total_transaction_fees_wei: string;
    total_transaction_fees_eth: string;
    total_calldata_bytes: number;
  };
};

const sepoliaRpc = process.env.SEPOLIA_RPC_URL;
if (sepoliaRpc === undefined || sepoliaRpc.includes("replace_with")) {
  throw new Error("SEPOLIA_RPC_URL is required to reconstruct the measured transactions");
}

const rpc = {
  ethereum: process.env.ETHEREUM_MAINNET_RPC_URL ?? "https://ethereum-rpc.publicnode.com",
  optimism: process.env.OPTIMISM_MAINNET_RPC_URL ?? "https://mainnet.optimism.io",
  arbitrum: process.env.ARBITRUM_ONE_RPC_URL ?? "https://arb1.arbitrum.io/rpc",
  base: process.env.BASE_MAINNET_RPC_URL ?? "https://mainnet.base.org",
};

function rpcHost(value: string): string {
  return new URL(value).host;
}

const providers = {
  sepolia: new JsonRpcProvider(sepoliaRpc, 11155111, { staticNetwork: true }),
  ethereum: new JsonRpcProvider(rpc.ethereum, 1, { staticNetwork: true }),
  optimism: new JsonRpcProvider(rpc.optimism, 10, { staticNetwork: true }),
  arbitrum: new JsonRpcProvider(rpc.arbitrum, 42161, { staticNetwork: true }),
  base: new JsonRpcProvider(rpc.base, 8453, { staticNetwork: true }),
};

const transactionResponses: TransactionResponse[] = [];
for (const transaction of workflow.transactions) {
  const response = await providers.sepolia.getTransaction(transaction.transaction_hash);
  if (response === null)
    throw new Error(`Missing Sepolia transaction ${transaction.transaction_hash}`);
  transactionResponses.push(response);
}

const totalGas = BigInt(workflow.measurements.total_gas_used);
const transactionCount = BigInt(workflow.measurements.confirmed_transaction_count);

function unsignedTransactions(chainId: number, gasPrice: bigint): string[] {
  return transactionResponses.map((transaction) => {
    const serialized = Transaction.from({
      type: 2,
      chainId,
      nonce: transaction.nonce,
      gasLimit: transaction.gasLimit,
      maxFeePerGas: gasPrice,
      maxPriorityFeePerGas: 0n,
      to: transaction.to,
      value: transaction.value,
      data: transaction.data,
      accessList: transaction.accessList,
    }).unsignedSerialized;
    return serialized;
  });
}

async function currentGasPrice(provider: JsonRpcProvider): Promise<bigint> {
  const feeData = await provider.getFeeData();
  if (feeData.gasPrice === null) throw new Error("Network did not return a gas price");
  return feeData.gasPrice;
}

async function networkSnapshot(provider: JsonRpcProvider) {
  const block = await provider.getBlock("latest");
  if (block === null) throw new Error("Latest network block is unavailable");
  return {
    block_number: block.number,
    block_timestamp: new Date(block.timestamp * 1000).toISOString(),
  };
}

const gasPriceOracleAbi = [
  "function getL1Fee(bytes) view returns (uint256)",
  "function operatorFeeScalar() view returns (uint256)",
  "function operatorFeeConstant() view returns (uint256)",
];

async function opStackEstimate(
  name: "optimism" | "base",
  chainId: number,
  provider: JsonRpcProvider,
) {
  const gasPrice = await currentGasPrice(provider);
  const serialized = unsignedTransactions(chainId, gasPrice);
  const oracle = new Contract(
    "0x420000000000000000000000000000000000000F",
    gasPriceOracleAbi,
    provider,
  );

  let l1DataFee = 0n;
  for (const transaction of serialized) {
    l1DataFee += (await oracle.getFunction("getL1Fee").staticCall(transaction)) as bigint;
  }

  let operatorFeeScalar = 0n;
  let operatorFeeConstant = 0n;
  try {
    operatorFeeScalar = (await oracle.getFunction("operatorFeeScalar").staticCall()) as bigint;
    operatorFeeConstant = (await oracle.getFunction("operatorFeeConstant").staticCall()) as bigint;
  } catch {
    // The operator fee is absent on profiles that do not expose these parameters.
  }
  const operatorFee = workflow.transactions.reduce(
    (sum, transaction) =>
      sum + (BigInt(transaction.gas_used) * operatorFeeScalar) / 1_000_000n + operatorFeeConstant,
    0n,
  );
  const executionFee = totalGas * gasPrice;
  const totalFee = executionFee + l1DataFee + operatorFee;
  return {
    network: name === "optimism" ? "Optimism" : "Base",
    chain_id: chainId,
    estimate_type: "snapshot estimate",
    method: "measured gas held constant plus live OP Stack execution, L1-data, and operator fees",
    gas_price_wei: gasPrice.toString(),
    serialized_transaction_bytes: serialized.reduce(
      (sum, transaction) => sum + (transaction.length - 2) / 2,
      0,
    ),
    execution_fee_wei: executionFee.toString(),
    l1_data_fee_wei: l1DataFee.toString(),
    operator_fee_wei: operatorFee.toString(),
    total_fee_wei: totalFee.toString(),
    total_fee_eth: formatEther(totalFee),
    ...(await networkSnapshot(provider)),
  };
}

async function arbitrumEstimate() {
  const provider = providers.arbitrum;
  const gasPriceInfo = new Contract(
    "0x000000000000000000000000000000000000006C",
    ["function getPricesInWei() view returns (uint256,uint256,uint256,uint256,uint256,uint256)"],
    provider,
  );
  const prices = (await gasPriceInfo
    .getFunction("getPricesInWei")
    .staticCall()) as readonly bigint[];
  const perL2Transaction = prices[0];
  const perL1CalldataByte = prices[1];
  const perArbGasTotal = prices[5];
  if (
    perL2Transaction === undefined ||
    perL1CalldataByte === undefined ||
    perArbGasTotal === undefined
  ) {
    throw new Error("Arbitrum gas-price tuple is incomplete");
  }
  const calldataBytes = BigInt(workflow.measurements.total_calldata_bytes);
  const executionFee = totalGas * perArbGasTotal;
  const dataFee = transactionCount * perL2Transaction + calldataBytes * perL1CalldataByte;
  const totalFee = executionFee + dataFee;
  return {
    network: "Arbitrum One",
    chain_id: 42161,
    estimate_type: "snapshot estimate",
    method:
      "measured gas held constant plus live ArbGas execution, per-transaction, and calldata-byte prices",
    gas_price_wei: perArbGasTotal.toString(),
    calldata_bytes: Number(calldataBytes),
    execution_fee_wei: executionFee.toString(),
    l1_data_fee_wei: dataFee.toString(),
    operator_fee_wei: "0",
    total_fee_wei: totalFee.toString(),
    total_fee_eth: formatEther(totalFee),
    per_l2_transaction_wei: perL2Transaction.toString(),
    per_l1_calldata_byte_wei: perL1CalldataByte.toString(),
    ...(await networkSnapshot(provider)),
  };
}

async function ethereumEstimate() {
  const provider = providers.ethereum;
  const gasPrice = await currentGasPrice(provider);
  const totalFee = totalGas * gasPrice;
  return {
    network: "Ethereum Mainnet",
    chain_id: 1,
    estimate_type: "snapshot estimate",
    method: "measured Sepolia gas held constant and multiplied by the live mainnet gas price",
    gas_price_wei: gasPrice.toString(),
    serialized_transaction_bytes: unsignedTransactions(1, gasPrice).reduce(
      (sum, transaction) => sum + (transaction.length - 2) / 2,
      0,
    ),
    execution_fee_wei: totalFee.toString(),
    l1_data_fee_wei: "0",
    operator_fee_wei: "0",
    total_fee_wei: totalFee.toString(),
    total_fee_eth: formatEther(totalFee),
    ...(await networkSnapshot(provider)),
  };
}

async function ethUsdSpot(): Promise<{ amount: number; source: string }> {
  const source = "https://api.coinbase.com/v2/prices/ETH-USD/spot";
  const response = await fetch(source);
  if (!response.ok) throw new Error(`Coinbase ETH-USD request failed with ${response.status}`);
  const body = (await response.json()) as { data?: { amount?: string } };
  const amount = Number(body.data?.amount);
  if (!Number.isFinite(amount) || amount <= 0) throw new Error("Coinbase ETH-USD value is invalid");
  return { amount, source };
}

const [ethereum, optimism, arbitrum, base, ethUsd] = await Promise.all([
  ethereumEstimate(),
  opStackEstimate("optimism", 10, providers.optimism),
  arbitrumEstimate(),
  opStackEstimate("base", 8453, providers.base),
  ethUsdSpot(),
]);

const measuredSepoliaFee = BigInt(workflow.measurements.total_transaction_fees_wei);
const networks = [
  {
    network: "Sepolia",
    chain_id: 11155111,
    estimate_type: "observed",
    method: "sum of the 57 confirmed transaction receipt fees",
    total_fee_wei: measuredSepoliaFee.toString(),
    total_fee_eth: formatEther(measuredSepoliaFee),
  },
  ethereum,
  optimism,
  arbitrum,
  base,
].map((network) => ({
  ...network,
  total_fee_usd:
    network.network === "Sepolia" ? null : Number(network.total_fee_eth) * ethUsd.amount,
}));

const report = {
  schema: "EVLLM_CROSS_NETWORK_COST_SNAPSHOT_V1",
  created_at: new Date().toISOString(),
  source_workflow: workflowPath,
  measured_transaction_count: workflow.measurements.confirmed_transaction_count,
  measured_gas_used: workflow.measurements.total_gas_used,
  measured_calldata_bytes: workflow.measurements.total_calldata_bytes,
  eth_usd_spot: ethUsd.amount,
  eth_usd_source: ethUsd.source,
  fee_parameter_sources: {
    ethereum: {
      rpc_host: rpcHost(rpc.ethereum),
      method: "eth_gasPrice",
    },
    optimism: {
      rpc_host: rpcHost(rpc.optimism),
      method: "eth_gasPrice and GasPriceOracle.getL1Fee(bytes)",
    },
    arbitrum: {
      rpc_host: rpcHost(rpc.arbitrum),
      method: "ArbGasInfo.getPricesInWei()",
    },
    base: {
      rpc_host: rpcHost(rpc.base),
      method: "eth_gasPrice and GasPriceOracle.getL1Fee(bytes)",
    },
  },
  interpretation:
    "Sepolia is observed. Other networks are contemporaneous scenario estimates that hold the measured execution-gas trace constant and apply the queried network fee parameters; they are not receipts from deployments on those networks.",
  networks,
  source_documentation: {
    optimism: "https://docs.optimism.io/app-developers/guides/transactions/estimates",
    arbitrum:
      "https://github.com/OffchainLabs/nitro-precompile-interfaces/blob/main/ArbGasInfo.sol",
    base: "https://docs.base.org/base-chain/network-information/network-fees",
  },
};

await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
for (const network of networks) {
  const usd = network.total_fee_usd === null ? "not applicable" : network.total_fee_usd.toFixed(4);
  console.log(
    `${network.network.padEnd(17)} ${network.total_fee_eth} ETH  USD ${usd} (${network.estimate_type})`,
  );
}
