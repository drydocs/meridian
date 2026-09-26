import { STRATEGY_ENGINE } from "@meridian/strategies";

// The shell is a single route for now. Individual views (simulation runner,
// run history) land in later issues, so there is no router dependency yet.
export default function App() {
  return (
    <main className="shell">
      <p className="shell__eyebrow">Meridian</p>
      <h1 className="shell__title">Strategy simulations</h1>
      <p className="shell__body">
        Scaffold only. Simulation controls and result views land in later
        issues.
      </p>
      <p className="shell__engine" data-testid="engine-version">
        Engine: {STRATEGY_ENGINE.name} v{STRATEGY_ENGINE.version}
      </p>
    </main>
  );
}
