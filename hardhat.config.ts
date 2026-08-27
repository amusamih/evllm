import hardhatEthers from "@nomicfoundation/hardhat-ethers";
import hardhatIgnitionEthers from "@nomicfoundation/hardhat-ignition-ethers";
import hardhatVerify from "@nomicfoundation/hardhat-verify";
import { config as loadEnvironment } from "dotenv";
import { configVariable, defineConfig } from "hardhat/config";

loadEnvironment({ path: ".env/local.env", quiet: true });
loadEnvironment({ path: ".env/sepolia-demo.env", quiet: true });

export default defineConfig({
  plugins: [hardhatEthers, hardhatIgnitionEthers, hardhatVerify],
  paths: {
    tests: {
      solidity: "test/contract",
    },
  },
  solidity: {
    profiles: {
      default: {
        version: "0.8.36",
        preferWasm: true,
        settings: {
          evmVersion: "cancun",
          viaIR: false,
          optimizer: { enabled: true, runs: 200 },
        },
      },
      production: {
        version: "0.8.36",
        preferWasm: true,
        settings: {
          evmVersion: "cancun",
          viaIR: false,
          optimizer: { enabled: true, runs: 200 },
        },
      },
    },
  },
  networks: {
    hardhatMainnet: {
      type: "edr-simulated",
      chainType: "l1",
      chainId: 31337,
      initialDate: "2026-08-11T00:00:00.000Z",
    },
    localhost: {
      type: "http",
      chainType: "l1",
      chainId: 31337,
      url: "http://127.0.0.1:8545",
      accounts: [
        configVariable("SEPOLIA_DEPLOYER_PRIVATE_KEY"),
        configVariable("SEPOLIA_GOVERNANCE_PRIVATE_KEY"),
      ],
    },
    sepolia: {
      type: "http",
      chainType: "l1",
      chainId: 11155111,
      url: configVariable("SEPOLIA_RPC_URL"),
      accounts: [
        configVariable("SEPOLIA_DEPLOYER_PRIVATE_KEY"),
        configVariable("SEPOLIA_GOVERNANCE_PRIVATE_KEY"),
      ],
    },
  },
  test: {
    solidity: {
      isolate: true,
      fuzz: {
        runs: Number(process.env.CONTRACT_FUZZ_RUNS ?? "2048"),
        seed:
          process.env.CONTRACT_TEST_SEED ??
          "0x6b5ccfbe3f2c4fa31be41cb932278248320af82d34a22d0fb5a5536180b9127c",
        failurePersistDir: ".local-results/contract-assurance/fuzz-failures",
      },
      invariant: {
        runs: Number(process.env.CONTRACT_INVARIANT_RUNS ?? "256"),
        depth: Number(process.env.CONTRACT_INVARIANT_DEPTH ?? "500"),
        failurePersistDir: ".local-results/contract-assurance/invariant-failures",
      },
    },
  },
  verify: {
    etherscan: {
      apiKey: configVariable("ETHERSCAN_API_KEY"),
    },
  },
});
