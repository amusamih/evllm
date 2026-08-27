export function recordedDecisionCodeMetadata(
  response: Readonly<{ decision_code: string | null }>,
): ReadonlyArray<readonly [string, string]> {
  return response.decision_code === null
    ? []
    : [["Recorded decision code", response.decision_code]];
}

export function responseSourceMetadata(
  response: Readonly<{
    decision_code: string | null;
    claims: readonly unknown[];
    model: Readonly<{ provider: string; model: string }>;
  }>,
): ReadonlyArray<readonly [string, string]> {
  const generated = response.model.provider !== "evllm";
  if (!generated) return [["Decision source", "Deterministic rules"]];
  if (response.decision_code !== null) {
    return [
      ["Decision source", "Checked deterministic record"],
      [
        "Explanation source",
        response.claims.length > 1 ? response.model.model : "No model explanation retained",
      ],
    ];
  }
  return [["Language model", response.model.model]];
}

export function interfacePage(): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta name="description" content="Research interface for governed second-life battery records, route assessment and decision support.">
  <title>Second-Life Battery Decision Support</title>
  <link rel="stylesheet" href="/interface.css">
</head>
<body>
  <a class="skip-link" href="#workspace">Skip to the workspace</a>
  <header class="site-header">
    <div class="brand" aria-label="Second-Life Battery Decision Support">
      <span class="brand-mark" aria-hidden="true"><span></span></span>
      <span><strong>Second-Life Battery</strong><small>Decision Support</small></span>
    </div>
    <div class="environment"><span aria-hidden="true"></span> Executed controlled cases</div>
  </header>

  <div class="app-shell">
    <aside class="side-panel" aria-label="Interface sections">
      <p class="eyebrow">Workspace</p>
      <nav class="section-nav" role="tablist" aria-label="System views">
        <button class="nav-item active" type="button" role="tab" aria-selected="true" aria-controls="assistant-view" data-view="assistant">
          <span class="nav-icon" aria-hidden="true">01</span><span>Decision support<small>Questions and governed responses</small></span>
        </button>
        <button class="nav-item" type="button" role="tab" aria-selected="false" aria-controls="assessment-view" data-view="assessment">
          <span class="nav-icon" aria-hidden="true">02</span><span>Route assessment<small>Six separate components</small></span>
        </button>
        <button class="nav-item" type="button" role="tab" aria-selected="false" aria-controls="status-view" data-view="status">
          <span class="nav-icon" aria-hidden="true">03</span><span>Workflow state<small>Records and transaction status</small></span>
        </button>
      </nav>
      <div class="scope-note">
        <strong>Read-only decision support</strong>
        <p>The system can explain permitted information but cannot sign transactions, release funds or change recorded ownership.</p>
      </div>
    </aside>

    <main id="workspace" class="workspace">
      <section id="assistant-view" class="view active" role="tabpanel" tabindex="0" aria-labelledby="assistant-heading">
        <div class="view-intro">
          <div class="view-heading">
            <div><p class="eyebrow">Source-linked conversational response</p><h1 id="assistant-heading">Decision support</h1></div>
            <span class="data-label">Executed controlled case</span>
          </div>
          <p class="lede">Inspect how the system answers from permitted records, declines when information is missing, and identifies conflicts that require an accountable decision.</p>
        </div>

        <div class="control-card chat-composer">
          <label for="assistant-question">Ask about the permitted battery records</label>
          <div class="composer-row">
            <textarea id="assistant-question" rows="2" maxlength="4000" aria-describedby="assistant-guidance"></textarea>
            <button id="run-assistant" class="primary-button" type="button">Send question</button>
          </div>
          <p id="assistant-guidance" class="composer-note">Press Enter to send. The response can use only the records permitted for the identified battery.</p>
        </div>

        <div id="assistant-loading" class="loading" hidden>Checking permission, record status and response support…</div>
        <div id="assistant-result" aria-live="polite"></div>
      </section>

      <section id="assessment-view" class="view" role="tabpanel" tabindex="0" aria-labelledby="assessment-heading" hidden>
        <div class="view-intro assessment-intro">
          <div class="view-heading">
            <div><p class="eyebrow">Deterministic comparison</p><h1 id="assessment-heading">Second-life route assessment</h1></div>
            <span class="data-label">Deterministic route calculation</span>
          </div>
          <p class="lede">Compare the technical gate, circularity, environmental indicators, economics, information adequacy and uncertainty for three declared routes.</p>
        </div>

        <div class="control-card compact">
          <label for="assessment-scenario">Assessment scenario</label>
          <div class="control-row">
            <select id="assessment-scenario">
              <option value="nominal">Complete compatible records</option>
              <option value="missing">Missing critical record</option>
              <option value="conflicting">Conflicting critical records</option>
            </select>
            <button id="run-assessment" class="primary-button" type="button">Calculate assessment</button>
          </div>
        </div>
        <div id="assessment-loading" class="loading" hidden>Calculating the six route components…</div>
        <div id="assessment-result" aria-live="polite"></div>
      </section>

      <section id="status-view" class="view" role="tabpanel" tabindex="0" aria-labelledby="status-heading" hidden>
        <div class="view-intro status-intro">
          <div class="view-heading">
            <div><p class="eyebrow">Read-only state projection</p><h1 id="status-heading">Record and transaction status</h1></div>
            <span class="data-label">Recorded workflow state</span>
          </div>
          <p class="lede">Follow one synthetic battery subject from recorded ownership and protected storage to its current marketplace stage.</p>
        </div>
        <div id="status-loading" class="loading">Loading the workflow projection…</div>
        <div id="status-result" aria-live="polite"></div>
      </section>
    </main>
  </div>
  <script src="/interface.js" defer></script>
</body>
</html>`;
}

export const interfaceStyles = String.raw`
:root {
  color-scheme: light;
  --ink: #102c3b;
  --muted: #5a707a;
  --line: #ccdcde;
  --canvas: #edf5f4;
  --surface: #ffffff;
  --navy: #0d293b;
  --navy-light: #173f52;
  --green: #16796b;
  --green-dark: #0b574f;
  --green-soft: #dff3ed;
  --blue: #347ea8;
  --blue-soft: #e4f1f8;
  --amber: #a36908;
  --amber-soft: #fff1cf;
  --red: #ab4949;
  --red-soft: #fbe8e8;
  --shadow: 0 18px 48px rgba(12, 46, 57, .10);
  --shadow-soft: 0 8px 24px rgba(12, 46, 57, .07);
  font-family: "Segoe UI Variable", "Segoe UI", Arial, sans-serif;
}
* { box-sizing: border-box; }
body { margin: 0; color: var(--ink); background: var(--canvas); }
button, select, textarea { font: inherit; }
button { cursor: pointer; }
.skip-link { position: fixed; left: 1rem; top: -4rem; z-index: 20; background: var(--ink); color: white; padding: .7rem 1rem; border-radius: .3rem; }
.skip-link:focus { top: 1rem; }
.site-header { position: relative; z-index: 3; min-height: 5.25rem; display: flex; align-items: center; justify-content: space-between; gap: 1rem; padding: 0 2rem; background: rgba(255,255,255,.96); border-bottom: 1px solid rgba(190,211,214,.8); box-shadow: 0 4px 18px rgba(12,46,57,.05); }
.site-header::after { content: ""; position: absolute; left: 0; right: 0; bottom: -1px; height: 3px; background: linear-gradient(90deg, var(--green), #45aa9b 55%, #72b8d6); }
.brand { display: flex; align-items: center; gap: .8rem; letter-spacing: -.01em; }
.brand strong, .brand small { display: block; }
.brand strong { color: var(--navy); font-size: 1.03rem; }
.brand small { color: var(--muted); margin-top: .15rem; }
.brand-mark { position: relative; display: inline-block; width: 2.4rem; height: 1.25rem; border: 2px solid var(--green); border-radius: .35rem; box-shadow: 0 0 0 .28rem var(--green-soft); }
.brand-mark::after { content: ""; position: absolute; right: -.35rem; top: .28rem; width: .25rem; height: .55rem; border-radius: 0 .15rem .15rem 0; background: var(--green); }
.brand-mark span { display: block; width: 72%; height: 100%; background: linear-gradient(90deg, #84d6c4, var(--green)); }
.environment { display: flex; align-items: center; gap: .5rem; color: var(--muted); font-size: .86rem; }
.environment span { width: .55rem; height: .55rem; border-radius: 50%; background: #2e8b67; box-shadow: 0 0 0 .25rem var(--green-soft); }
.app-shell { min-height: calc(100vh - 5.25rem); display: grid; grid-template-columns: 18rem minmax(0, 1fr); }
.side-panel { position: relative; z-index: 2; padding: 2.25rem 1.2rem; color: #eaf6f4; background: linear-gradient(165deg, var(--navy) 0%, #10384a 58%, #12534f 145%); box-shadow: 8px 0 30px rgba(9,35,48,.08); }
.eyebrow { margin: 0 0 .55rem; color: var(--green); font-size: .73rem; font-weight: 750; letter-spacing: .09em; text-transform: uppercase; }
.side-panel > .eyebrow { color: #8dd6c8; }
.section-nav { display: grid; gap: .55rem; }
.nav-item { width: 100%; display: grid; grid-template-columns: 2.35rem 1fr; gap: .7rem; align-items: center; padding: .88rem; text-align: left; color: #eff9f7; border: 1px solid transparent; border-radius: .8rem; background: transparent; transition: transform .18s ease, background .18s ease, border-color .18s ease; }
.nav-item:hover { background: rgba(255,255,255,.09); transform: translateX(2px); }
.nav-item.active { color: var(--navy); background: var(--surface); border-color: rgba(255,255,255,.7); box-shadow: 0 12px 28px rgba(3,24,35,.23); }
.nav-item:focus-visible, .primary-button:focus-visible, select:focus-visible, textarea:focus-visible { outline: 3px solid #7ab6dc; outline-offset: 2px; }
.nav-item > span:not(.nav-icon) { font-size: .92rem; font-weight: 700; }
.nav-item small { display: block; margin-top: .18rem; color: #a9c3ca; font-size: .73rem; font-weight: 400; line-height: 1.3; }
.nav-item.active small { color: var(--muted); }
.nav-icon { display: grid; place-items: center; width: 2.2rem; height: 2.2rem; color: #c5eee5; background: rgba(108,211,190,.15); border: 1px solid rgba(140,224,207,.18); border-radius: .65rem; font-size: .72rem; font-weight: 800; }
.nav-item.active .nav-icon { color: var(--green-dark); background: var(--green-soft); border-color: #c3e3da; }
.scope-note { margin-top: 2rem; padding: 1.05rem; color: #d9ebe8; border: 1px solid rgba(188,227,220,.22); border-radius: .8rem; background: rgba(255,255,255,.07); font-size: .78rem; line-height: 1.55; }
.scope-note p { margin: .35rem 0 0; }
.workspace { position: relative; padding: 2.5rem clamp(1.25rem, 4vw, 4rem) 4rem; overflow: hidden; background: radial-gradient(circle at 92% 5%, rgba(81,176,157,.14), transparent 24rem), radial-gradient(circle at 18% 92%, rgba(82,146,184,.10), transparent 28rem), linear-gradient(145deg, #f5f9f8, #eef4f4); }
.view { max-width: 76rem; margin: 0 auto; }
.view-intro { position: relative; overflow: hidden; padding: 1.65rem 1.75rem 1.55rem; border: 1px solid #cfe1df; border-radius: 1.05rem; background: linear-gradient(125deg, rgba(255,255,255,.98), rgba(223,244,238,.93)); box-shadow: var(--shadow-soft); }
.view-intro::after { content: ""; position: absolute; right: -3.6rem; bottom: -5.8rem; width: 13rem; height: 13rem; border: 1.7rem solid rgba(22,121,107,.06); border-radius: 50%; pointer-events: none; }
.assessment-intro { background: linear-gradient(125deg, rgba(255,255,255,.98), rgba(227,241,249,.95)); }
.status-intro { background: linear-gradient(125deg, rgba(255,255,255,.98), rgba(232,239,248,.96)); }
.view-heading { display: flex; justify-content: space-between; align-items: flex-start; gap: 1rem; }
h1 { margin: 0; font-size: clamp(1.75rem, 3vw, 2.65rem); line-height: 1.1; letter-spacing: -.035em; }
.lede { position: relative; z-index: 1; max-width: 57rem; margin: .8rem 0 0; color: var(--muted); font-size: 1.01rem; line-height: 1.65; }
.data-label { position: relative; z-index: 1; flex: none; padding: .45rem .72rem; color: var(--green-dark); background: rgba(255,255,255,.78); border: 1px solid #bddfd5; border-radius: 999px; box-shadow: 0 4px 14px rgba(21,94,84,.07); font-size: .74rem; font-weight: 700; }
.control-card, .result-panel, .decision-banner, .route-card, .status-card { background: var(--surface); border: 1px solid var(--line); box-shadow: var(--shadow); }
.control-card { position: relative; margin-top: 1.25rem; padding: 1.25rem 1.35rem; border-radius: .9rem; box-shadow: var(--shadow-soft); }
.control-card::before { content: ""; position: absolute; inset: 0 auto 0 0; width: 4px; border-radius: .9rem 0 0 .9rem; background: linear-gradient(var(--green), #61bdac); }
.control-card.compact { margin-bottom: 1.4rem; }
.control-card label { display: block; margin-bottom: .5rem; font-size: .8rem; font-weight: 750; }
.control-row { display: flex; gap: .7rem; }
select { flex: 1; min-width: 0; padding: .78rem .9rem; color: var(--ink); border: 1px solid #afc4c9; border-radius: .6rem; background: #fbfdfd; box-shadow: inset 0 1px 2px rgba(12,46,57,.03); }
.composer-row { display: grid; grid-template-columns: minmax(0,1fr) auto; gap: .75rem; align-items: stretch; }
textarea { width: 100%; min-height: 4.2rem; resize: vertical; padding: .85rem .95rem; color: var(--ink); border: 1px solid #afc4c9; border-radius: .7rem; background: #fbfdfd; box-shadow: inset 0 1px 2px rgba(12,46,57,.03); line-height: 1.45; }
.composer-note { margin: .7rem 0 0; color: var(--muted); font-size: .75rem; }
.primary-button { flex: none; padding: .78rem 1.15rem; color: white; border: 1px solid var(--green-dark); border-radius: .6rem; background: linear-gradient(135deg, var(--green), var(--green-dark)); box-shadow: 0 8px 18px rgba(18,105,91,.20); font-weight: 700; transition: transform .18s ease, box-shadow .18s ease; }
.primary-button:hover { transform: translateY(-1px); box-shadow: 0 11px 22px rgba(18,105,91,.26); }
.primary-button:disabled { opacity: .55; cursor: wait; }
.question { margin: .85rem 0 0; color: #3f535c; line-height: 1.5; }
.loading { margin: 1.2rem 0; padding: 1rem; color: var(--muted); border: 1px dashed #8eb7b2; border-radius: .7rem; background: rgba(255,255,255,.72); }
.chat-exchange { margin-top: 1.25rem; }
.chat-message { max-width: 78%; }
.user-message { margin-left: auto; padding: .8rem 1rem; color: white; border-radius: 1rem 1rem .25rem 1rem; background: linear-gradient(135deg, var(--navy-light), var(--navy)); box-shadow: var(--shadow-soft); }
.user-message .message-author { display: block; margin-bottom: .25rem; color: #8dd6c8; font-size: .7rem; font-weight: 800; letter-spacing: .06em; text-transform: uppercase; }
.user-message p { margin: 0; line-height: 1.45; }
.result-panel { margin-top: .75rem; border-radius: 1rem 1rem 1rem .25rem; overflow: hidden; }
.result-header, .decision-banner { display: flex; justify-content: space-between; align-items: center; gap: 1rem; }
.result-header { padding: 1.05rem 1.3rem; background: linear-gradient(90deg, #f5fbf9, #eef7f6); border-bottom: 1px solid var(--line); }
.result-header h2, .decision-banner h2 { margin: 0; font-size: 1.08rem; }
.result-body { padding: 1.4rem; }
.response-source { display: flex; align-items: center; gap: .55rem; margin: 0 0 .8rem; color: var(--muted); font-size: .78rem; line-height: 1.45; }
.response-source::before { content: ""; flex: none; width: .55rem; height: .55rem; border-radius: 50%; background: var(--blue); box-shadow: 0 0 0 .22rem var(--blue-soft); }
.response-source.deterministic::before { background: var(--amber); box-shadow: 0 0 0 .22rem var(--amber-soft); }
.result-summary { margin: 0; font-size: 1.16rem; font-weight: 560; line-height: 1.65; }
.badge { display: inline-flex; align-items: center; gap: .35rem; padding: .38rem .62rem; border: 1px solid transparent; border-radius: 999px; font-size: .7rem; font-weight: 800; text-transform: uppercase; letter-spacing: .04em; }
.badge.answer, .badge.PASS { color: var(--green-dark); background: var(--green-soft); }
.badge.abstain, .badge.UNKNOWN { color: var(--amber); background: var(--amber-soft); }
.badge.requires_external_decision, .badge.FAIL { color: var(--red); background: var(--red-soft); }
.claim-list, .citation-list, .reason-list { list-style: none; margin: 1rem 0 0; padding: 0; }
.claim-list li { position: relative; padding: .9rem 1rem .9rem 2.45rem; margin-top: .55rem; background: linear-gradient(90deg, var(--blue-soft), #f2f8fb); border-left: 4px solid var(--blue); border-radius: .55rem; line-height: 1.5; }
.claim-list li::before { content: "✓"; position: absolute; left: .8rem; color: var(--blue); font-weight: 900; }
.citation-list { display: grid; grid-template-columns: repeat(auto-fit,minmax(16rem,1fr)); gap: .65rem; }
.citation-list li { padding: .9rem; border: 1px solid var(--line); border-radius: .65rem; background: #fbfdfd; }
.citation-list strong, .citation-list span { display: block; overflow-wrap: anywhere; }
.citation-list span { margin-top: .25rem; color: var(--muted); font-size: .75rem; }
.result-meta { display: grid; grid-template-columns: repeat(auto-fit,minmax(9rem,1fr)); gap: .65rem; margin-top: 1.2rem; padding-top: 1rem; border-top: 1px solid var(--line); }
.result-meta div { min-width: 0; }
.result-meta dt { color: var(--muted); font-size: .7rem; text-transform: uppercase; letter-spacing: .06em; }
.result-meta dd { margin: .25rem 0 0; font-size: .83rem; overflow-wrap: anywhere; }
.reason-list li { margin-top: .4rem; color: #6c4c13; }
.decision-banner { margin: 1.2rem 0; padding: 1.05rem 1.25rem; border-radius: .85rem; }
.decision-banner.answer { border-left: 5px solid var(--green); }
.decision-banner.abstain { border-left: 5px solid var(--amber); }
.decision-banner.requires_external_decision { border-left: 5px solid var(--red); }
.decision-banner p { margin: .25rem 0 0; color: var(--muted); }
.route-grid { display: grid; grid-template-columns: repeat(3,minmax(0,1fr)); gap: 1rem; }
.route-card { min-width: 0; border-radius: .9rem; overflow: hidden; transition: transform .18s ease; }
.route-card:hover { transform: translateY(-2px); }
.route-card.preferred { border-color: #72bca8; box-shadow: 0 18px 42px rgba(22,121,107,.18); }
.route-title { min-height: 5.3rem; padding: 1rem; background: linear-gradient(145deg, #f9fcfb, #edf6f4); border-bottom: 1px solid var(--line); }
.route-card:nth-child(2) .route-title { background: linear-gradient(145deg, #fafcfd, #edf4f8); }
.route-card:nth-child(3) .route-title { background: linear-gradient(145deg, #fcfbf8, #f6f1e7); }
.route-title h3 { margin: .5rem 0 0; font-size: 1.02rem; line-height: 1.3; }
.metric-list { display: grid; margin: 0; }
.metric { display: grid; grid-template-columns: 2.2rem minmax(0,1fr); gap: .7rem; padding: .78rem .9rem; border-bottom: 1px solid #edf1f2; }
.metric:last-child { border-bottom: 0; }
.metric-symbol { display: grid; place-items: center; width: 2rem; height: 2rem; border: 1px solid #c8e6de; border-radius: .55rem; color: var(--green-dark); background: var(--green-soft); font-weight: 850; }
.metric dt { font-size: .73rem; color: var(--muted); }
.metric dd { margin: .2rem 0 0; font-size: .83rem; line-height: 1.35; overflow-wrap: anywhere; }
.status-grid { display: grid; grid-template-columns: repeat(2,minmax(0,1fr)); gap: 1rem; }
.status-card { position: relative; overflow: hidden; padding: 1.2rem; border-radius: .9rem; }
.status-card::before { content: ""; position: absolute; left: 0; right: 0; top: 0; height: 4px; background: linear-gradient(90deg, var(--green), #55b7a5); }
.status-card:nth-child(2)::before { background: linear-gradient(90deg, var(--blue), #72b8d6); }
.status-card:nth-child(3)::before { background: linear-gradient(90deg, #8369b2, #ac91d4); }
.status-card:nth-child(4)::before { background: linear-gradient(90deg, #c58720, #ddb763); }
.status-card h2 { margin: 0 0 1rem; font-size: 1rem; }
.status-card dl { margin: 0; display: grid; grid-template-columns: minmax(8rem,.7fr) 1.3fr; gap: .65rem 1rem; }
.status-card dt { color: var(--muted); font-size: .76rem; }
.status-card dd { margin: 0; font-size: .84rem; font-weight: 650; overflow-wrap: anywhere; }
.status-card.current { border-color: #b9d3e2; box-shadow: 0 18px 42px rgba(52,126,168,.14); }
.execution-trail { margin-top: 1.1rem; padding: 1.15rem 1.25rem; background: var(--surface); border: 1px solid var(--line); border-radius: .9rem; box-shadow: var(--shadow-soft); }
.execution-trail h2 { margin: 0; font-size: 1.02rem; }
.execution-summary { margin: .35rem 0 1rem; color: var(--muted); font-size: .8rem; }
.execution-steps { display: grid; grid-template-columns: repeat(2,minmax(0,1fr)); gap: .65rem; margin: 0; padding: 0; list-style: none; counter-reset: execution; }
.execution-steps li { position: relative; min-height: 4.2rem; padding: .75rem .8rem .7rem 2.8rem; border: 1px solid #d5e2e3; border-radius: .65rem; background: #f8fbfb; counter-increment: execution; }
.execution-steps li::before { content: counter(execution); position: absolute; left: .75rem; top: .75rem; display: grid; place-items: center; width: 1.4rem; height: 1.4rem; color: white; background: var(--green); border-radius: 50%; font-size: .7rem; font-weight: 800; }
.execution-steps strong, .execution-steps span { display: block; }
.execution-steps strong { font-size: .82rem; line-height: 1.35; }
.execution-steps span { margin-top: .25rem; color: var(--muted); font-size: .72rem; }
.empty-note { margin: 1rem 0 0; color: var(--muted); font-size: .88rem; }
.error-message { padding: 1rem; color: var(--red); background: var(--red-soft); border: 1px solid #e6baba; border-radius: .5rem; }
.capture-mode { background: white; }
.capture-mode .skip-link, .capture-mode .site-header, .capture-mode .side-panel, .capture-mode .view-intro, .capture-mode .control-card, .capture-mode .loading { display: none !important; }
.capture-mode .app-shell { min-height: auto; display: block; }
.capture-mode .workspace { padding: 1.25rem; overflow: visible; background: white; }
.capture-mode .view { max-width: 68rem; }
.capture-mode .chat-exchange { margin-top: 0; }
.capture-mode .chat-message { max-width: 72%; }
.capture-mode .result-panel { box-shadow: 0 8px 24px rgba(12,46,57,.08); }
.capture-compact .workspace { padding: .7rem; }
.capture-compact .view { max-width: 72rem; }
.capture-compact .chat-message { max-width: 86%; padding: .55rem .75rem; }
.capture-compact .user-message p { line-height: 1.35; }
.capture-compact .result-panel { margin-top: .5rem; }
.capture-compact .result-header { padding: .65rem .9rem; }
.capture-compact .result-body { padding: .8rem .9rem; }
.capture-compact .response-source { margin-bottom: .55rem; }
.capture-compact .result-summary { font-size: 1.03rem; line-height: 1.45; }
.capture-compact .claim-list { margin-top: .65rem; }
.capture-compact .claim-list li { margin-top: .35rem; padding: .55rem .7rem .55rem 2.15rem; line-height: 1.35; }
.capture-compact .claim-list li::before { left: .7rem; }
.capture-compact .citation-heading,
.capture-compact .citation-list { display: none; }
.capture-compact .result-meta { grid-template-columns: repeat(5,minmax(0,1fr)); gap: .4rem; margin-top: .7rem; padding-top: .6rem; }
.capture-compact .result-meta dt { font-size: .62rem; }
.capture-compact .result-meta dd { margin-top: .15rem; font-size: .72rem; }
.capture-compact .decision-banner { margin: .45rem 0 .55rem; padding: .6rem .8rem; }
.capture-compact .decision-banner p { font-size: .78rem; }
.capture-compact .route-grid { gap: .55rem; }
.capture-compact .route-title { min-height: 3.8rem; padding: .55rem .65rem; }
.capture-compact .route-title h3 { margin-top: .3rem; font-size: .83rem; }
.capture-compact .metric { grid-template-columns: 1.55rem minmax(0,1fr); gap: .45rem; padding: .38rem .5rem; }
.capture-compact .metric-symbol { width: 1.45rem; height: 1.45rem; border-radius: .4rem; font-size: .72rem; }
.capture-compact .metric dt { font-size: .62rem; }
.capture-compact .metric dd { margin-top: .1rem; font-size: .7rem; line-height: 1.25; }
@media (max-width: 900px) {
  .app-shell { grid-template-columns: 1fr; }
  .side-panel { padding: .85rem 1rem; border-right: 0; border-bottom: 1px solid rgba(255,255,255,.12); }
  .side-panel > .eyebrow, .scope-note { display: none; }
  .section-nav { grid-template-columns: repeat(3,minmax(0,1fr)); }
  .nav-item { grid-template-columns: 1fr; text-align: center; padding: .65rem; }
  .nav-icon { margin: auto; }
  .nav-item small { display: none; }
  .workspace { padding-top: 1.5rem; }
  .route-grid { grid-template-columns: 1fr; }
}
@media (max-width: 620px) {
  .site-header { padding: 0 1rem; }
  .environment { display: none; }
  .control-row, .view-heading { align-items: stretch; flex-direction: column; }
  .view-intro { padding: 1.3rem; }
  .data-label { align-self: flex-start; }
  .primary-button { width: 100%; }
  .composer-row { grid-template-columns: 1fr; }
  .chat-message { max-width: 92%; }
  .status-grid { grid-template-columns: 1fr; }
  .status-card dl { grid-template-columns: 1fr; gap: .2rem; }
  .status-card dd { margin-bottom: .55rem; }
  .execution-steps { grid-template-columns: 1fr; }
}
`;

const recordedDecisionCodeMetadataClient = recordedDecisionCodeMetadata.toString();
const responseSourceMetadataClient = responseSourceMetadata.toString();

export const interfaceClient = String.raw`
${recordedDecisionCodeMetadataClient}
${responseSourceMetadataClient}

const routeNames = {
  "continued-compatible-ev-use": "Continued compatible EV use",
  "stationary-storage-repurposing": "Stationary storage repurposing",
  recycling: "Recycling"
};

const navButtons = [...document.querySelectorAll("[data-view]")];
for (const button of navButtons) {
  button.addEventListener("click", () => showView(button.dataset.view));
}

function showView(name) {
  for (const button of navButtons) {
    const active = button.dataset.view === name;
    button.classList.toggle("active", active);
    button.setAttribute("aria-selected", String(active));
  }
  for (const view of document.querySelectorAll(".view")) {
    const active = view.id === name + "-view";
    view.classList.toggle("active", active);
    view.hidden = !active;
  }
  if (name === "status" && !document.getElementById("status-result").hasChildNodes()) loadStatus();
}

const assistantQuestion = document.getElementById("assistant-question");
assistantQuestion.addEventListener("keydown", event => {
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    runAssistant();
  }
});
document.getElementById("run-assistant").addEventListener("click", runAssistant);
document.getElementById("run-assessment").addEventListener("click", runAssessment);

async function runAssistant() {
  const button = document.getElementById("run-assistant");
  const loading = document.getElementById("assistant-loading");
  const target = document.getElementById("assistant-result");
  const question = assistantQuestion.value.trim();
  if (question.length === 0) {
    assistantQuestion.focus();
    return;
  }
  setBusy(button, loading, true);
  try {
    const idempotencyKey = crypto.randomUUID();
    const data = await api("/api/v1/interface/assistant", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ question, idempotency_key: idempotencyKey })
    });
    target.append(renderAssistant(data));
  } catch (error) {
    target.append(errorNode(error));
  } finally {
    setBusy(button, loading, false);
  }
}

function renderAssistant(data) {
  const response = data.response;
  const generated = response.model.provider !== "evllm";
  const typedDecision = response.decision_code !== null;
  const explanationRetained = generated && (!typedDecision || response.claims.length > 1);
  const exchange = element("section", "chat-exchange");
  const userMessage = element("article", "chat-message user-message");
  userMessage.append(textBlock("span", "You", "message-author"));
  userMessage.append(textBlock("p", data.question));
  exchange.append(userMessage);
  const panel = element("article", "result-panel");
  const header = element("div", "result-header");
  header.append(textBlock(
    "h2",
    typedDecision
      ? (explanationRetained ? "Recorded decision with AI explanation" : "System-controlled decision")
      : (generated ? "AI-generated explanation" : "System-controlled outcome")
  ));
  header.append(badge(response.outcome));
  panel.append(header);
  const body = element("div", "result-body");
  body.append(textBlock(
    "p",
    typedDecision
      ? (explanationRetained
          ? "The application rendered the decision from a checked deterministic record, and the language model supplied the source-linked explanation."
          : "The application rendered the decision from a checked deterministic record. No model explanation was retained.")
      : (generated
          ? "The language model prepared this response from records selected and checked by the application."
          : "The application returned this governed outcome before language-model generation."),
    "response-source" + (generated && explanationRetained ? "" : " deterministic")
  ));
  body.append(textBlock("p", response.summary, "result-summary"));
  if (response.claims.length > 0) {
    const claims = element("ul", "claim-list");
    for (const claim of response.claims) {
      const item = element("li");
      item.append(document.createTextNode(claim.text + " "));
      item.append(textBlock("strong", "[" + claim.citation_ids.map(recordLabel).join(", ") + "]"));
      claims.append(item);
    }
    body.append(claims);
  }
  if (response.citations.length > 0) {
    body.append(textBlock("h3", "Referenced records", "citation-heading"));
    const citations = element("ul", "citation-list");
    for (const citation of response.citations) {
      const item = element("li");
      item.append(textBlock("strong", recordLabel(citation.support_id)));
      item.append(textBlock("span", "Version " + citation.resource_version + " · status " + humanize(citation.status)));
      item.append(textBlock("span", citation.chain_reference ? "Traceable source reference retained" : "No source reference retained"));
      citations.append(item);
    }
    body.append(citations);
  }
  const validationReasons = response.model.provider === "evllm" ? [] : response.validation.codes;
  const reasons = [...response.warnings, ...response.evidence_reason_codes, ...validationReasons]
    .filter(reason => reason !== response.summary);
  if (reasons.length > 0) {
    body.append(textBlock("h3", response.outcome === "answer" ? "Important qualification" : "Why this outcome was returned"));
    const list = element("ul", "reason-list");
    for (const reason of [...new Set(reasons)]) list.append(textBlock("li", reasonText(reason)));
    body.append(list);
  }
  const meta = element("dl", "result-meta");
  addMeta(meta, "Case", data.caseLabel);
  addMeta(meta, "Record state", recordStateLabel(response));
  for (const [term, value] of recordedDecisionCodeMetadata(response)) addMeta(meta, term, value);
  addMeta(meta, "Response check", responseCheckLabel(response));
  for (const [term, value] of responseSourceMetadata(response)) addMeta(meta, term, value);
  addMeta(meta, "Audit entry", "Recorded and hash-linked");
  body.append(meta);
  panel.append(body);
  exchange.append(panel);
  return exchange;
}

async function runAssessment() {
  const button = document.getElementById("run-assessment");
  const loading = document.getElementById("assessment-loading");
  const target = document.getElementById("assessment-result");
  setBusy(button, loading, true);
  target.replaceChildren();
  try {
    const scenario = document.getElementById("assessment-scenario").value;
    const data = await api("/api/v1/interface/assessment/" + encodeURIComponent(scenario));
    target.append(renderAssessment(data));
  } catch (error) {
    target.append(errorNode(error));
  } finally {
    setBusy(button, loading, false);
  }
}

function renderAssessment(data) {
  const wrapper = document.createDocumentFragment();
  const result = data.result;
  const banner = element("section", "decision-banner " + result.decisionState);
  const message = element("div");
  message.append(textBlock("h2", assessmentTitle(result)));
  message.append(textBlock("p", assessmentExplanation(result)));
  banner.append(message, badge(result.decisionState));
  wrapper.append(banner);
  const grid = element("div", "route-grid");
  for (const route of result.routes) {
    const preferred = result.preferredRoute === route.routeId;
    const card = element("article", "route-card" + (preferred ? " preferred" : ""));
    const title = element("div", "route-title");
    title.append(badge(route.G));
    title.append(textBlock("h3", routeNames[route.routeId]));
    card.append(title);
    const metrics = element("dl", "metric-list");
    addMetric(metrics, "G", "Technical and safety gate", humanize(route.G));
    addMetric(metrics, "C", "Circularity", circularityText(route.C));
    addMetric(metrics, "I", "Environmental indicators", route.I.map(item => formatDecimal(item.value) + " " + item.unit + " (" + humanize(item.category) + ")").join("; "));
    addMetric(metrics, "E", "Economics", route.E.currency + " " + formatDecimal(route.E.netPresentValue) + " NPV" + (route.E.paybackPeriod ? " · payback period " + route.E.paybackPeriod : ""));
    addMetric(metrics, "A", "Information adequacy", percent(route.A.coverage) + " usable · " + route.A.conflictCount + " conflicts");
    addMetric(metrics, "U", "Uncertainty", percent(route.U.gatePassFrequency) + " gate pass · ranking " + (route.U.rankStable ? "stable" : "unstable"));
    card.append(metrics);
    grid.append(card);
  }
  wrapper.append(grid);
  return wrapper;
}

async function loadStatus() {
  const loading = document.getElementById("status-loading");
  const target = document.getElementById("status-result");
  try {
    const data = await api("/api/v1/interface/status");
    const grid = element("div", "status-grid");
    grid.append(statusCard("Battery subject", [
      ["Battery ID", data.battery.id], ["Recorded owner", data.battery.recordedOwner], ["Ownership state", data.battery.ownershipState]
    ]));
    grid.append(statusCard("Protected record", [
      ["Record", data.protectedRecord.id + " · version " + data.protectedRecord.version], ["State", data.protectedRecord.state], ["Storage class", data.protectedRecord.criticality], ["Replica", data.protectedRecord.replicaState]
    ]));
    grid.append(statusCard("Marketplace transaction", [
      ["Listing", data.marketplace.listing], ["Agreement", data.marketplace.agreement], ["Current state", data.marketplace.state], ["Next authorized action", data.marketplace.nextAuthorizedAction]
    ], true));
    grid.append(statusCard("Confirmation trail", [
      ["Latest event", data.audit.lastEvent], ["Recorded state", data.audit.chainState]
    ]));
    target.append(grid);
    if (data.execution) {
      const trail = element("section", "execution-trail");
      trail.append(textBlock("h2", "Confirmed transaction sequence"));
      trail.append(textBlock("p", data.execution.chain + " · Run " + data.execution.runId, "execution-summary"));
      const steps = element("ol", "execution-steps");
      for (const transaction of data.execution.transactions) {
        const item = element("li");
        item.append(textBlock("strong", transaction.step));
        item.append(textBlock("span", "Block " + transaction.blockNumber + " · transaction " + shortHash(transaction.transactionHash)));
        steps.append(item);
      }
      trail.append(steps);
      target.append(trail);
    }
  } catch (error) {
    target.append(errorNode(error));
  } finally {
    loading.hidden = true;
  }
}

function statusCard(title, rows, current = false) {
  const card = element("article", "status-card" + (current ? " current" : ""));
  card.append(textBlock("h2", title));
  const list = element("dl");
  for (const [term, value] of rows) {
    list.append(textBlock("dt", term), textBlock("dd", value));
  }
  card.append(list);
  return card;
}

function assessmentTitle(result) {
  if (result.decisionState === "answer") return "Preferred route under the declared scenario";
  if (result.decisionState === "requires_external_decision") return "Accountable decision required";
  return "No route preference returned";
}

function assessmentExplanation(result) {
  if (result.decisionState === "answer") return routeNames[result.preferredRoute] + " is the single stable and undominated passing route.";
  if (result.decisionState === "requires_external_decision") return "Critical records conflict, so the system does not resolve the disagreement automatically.";
  return "The available records do not support one stable route preference.";
}

function circularityText(value) {
  return value.value !== undefined ? formatDecimal(value.value) + " / 100" : formatDecimal(value.lower) + "–" + formatDecimal(value.upper) + " / 100";
}

function addMetric(list, symbol, label, value) {
  const row = element("div", "metric");
  row.append(textBlock("span", symbol, "metric-symbol"));
  const content = element("div");
  content.append(textBlock("dt", label), textBlock("dd", value));
  row.append(content);
  list.append(row);
}

function addMeta(list, term, value) {
  const item = element("div");
  item.append(textBlock("dt", term), textBlock("dd", value));
  list.append(item);
}

function badge(value) {
  return textBlock("span", humanize(value), "badge " + value);
}

function percent(value) {
  return Math.round(Number(value) * 100) + "%";
}

function formatDecimal(value) {
  return new Intl.NumberFormat("en", { maximumFractionDigits: 6 }).format(Number(value));
}

function humanize(value) {
  return String(value).replaceAll("_", " ").replaceAll("-", " ").replace(/\b\w/g, letter => letter.toUpperCase());
}

function reasonText(value) {
  const text = String(value);
  if (text === "missing-evidence") return "Required information is missing";
  if (text === "conflicting-evidence") return "Current records conflict";
  if (text === "external-decision-required") return "An accountable external decision is required";
  return text.includes(" ") ? text : humanize(text);
}

function recordStateLabel(response) {
  if (response.validation.codes.includes("missing-support")) return "Incomplete";
  if (response.validation.codes.includes("conflicting-support")) return "Conflicting";
  return humanize(response.evidence_state);
}

function responseCheckLabel(response) {
  if (response.validation.status === "passed") return "Passed";
  if (response.model.provider === "evllm") return "Governed boundary applied";
  return "Generated response withheld";
}

function recordLabel(value) {
  const match = String(value).match(/record-([1-9][0-9]*)$/);
  return match ? "Record " + match[1] : "Referenced record";
}

function shortHash(value) {
  const text = String(value);
  return text.length > 18 ? text.slice(0, 10) + "…" + text.slice(-6) : text;
}

function element(tag, className) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  return node;
}

function textBlock(tag, text, className) {
  const node = element(tag, className);
  node.textContent = text;
  return node;
}

function errorNode(error) {
  return textBlock("p", error instanceof Error ? error.message : "The interface request failed.", "error-message");
}

function setBusy(button, loading, busy) {
  button.disabled = busy;
  loading.hidden = !busy;
}

async function api(path, options) {
  const response = await fetch(path, options);
  const body = await response.json();
  if (!response.ok) throw new Error(body.error?.message || "The interface request failed.");
  return body.result;
}

const initial = new URLSearchParams(window.location.search);
if (["full", "compact"].includes(initial.get("capture"))) document.body.classList.add("capture-mode");
if (initial.get("capture") === "compact") document.body.classList.add("capture-compact");
const initialQuestion = initial.get("question");
if (initialQuestion) assistantQuestion.value = initialQuestion;
if (["nominal", "missing", "conflicting"].includes(initial.get("assessment"))) {
  document.getElementById("assessment-scenario").value = initial.get("assessment");
}
const initialView = ["assistant", "assessment", "status"].includes(initial.get("view"))
  ? initial.get("view")
  : "assistant";
showView(initialView);
if (initialView === "assessment") runAssessment();
else if (initialView === "assistant" && initialQuestion) runAssistant();
`;
