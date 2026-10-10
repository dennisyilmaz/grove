/**
 * The page the visual gate renders.
 *
 * It mounts real components — not copies of their markup — freezes animation,
 * sweeps the rendered result for invariant violations, and publishes the
 * verdict into the DOM as JSON. A headless browser only has to load it and dump
 * the document; no debugging protocol, no driver library, no fuzzy threshold.
 *
 * Adding a scene is how a surface becomes gate-visible. A component that is not
 * here is a component only a human's eyes can check.
 */
import { StrictMode, useState } from "react";
import { createRoot } from "react-dom/client";
import { ChatComposer } from "./components/ChatComposer.tsx";
import "./index.css";
import { Button, Card, Input, Select, Textarea } from "./lib/ui.tsx";
import {
  installProbeStyles,
  sweepFocusIndicators,
  type Violation,
} from "./lib/visualInvariants.ts";

export const VERDICT_ID = "grove-visual-verdict";

function Scene({ name, children }: { name: string; children: React.ReactNode }) {
  return (
    <section data-scene={name} className="space-y-2 p-4">
      <h2 className="label">{name}</h2>
      {children}
    </section>
  );
}

function ComposerScene({ initial }: { initial: string }) {
  const [draft, setDraft] = useState(initial);
  return <ChatComposer value={draft} onChange={setDraft} onSubmit={() => {}} />;
}

function Probe() {
  return (
    <div className="bg-canvas">
      <Scene name="composer-empty">
        <ComposerScene initial="" />
      </Scene>
      <Scene name="composer-with-text">
        <ComposerScene initial="ship the elevated composer" />
      </Scene>
      {/* The shared controls every other page is built from: if the global
          focus rule ever collides with one of these, it collides everywhere. */}
      <Scene name="shared-controls">
        <Card>
          <div className="flex flex-wrap items-center gap-3">
            <Button kind="primary">Primary</Button>
            <Button>Secondary</Button>
            <Input placeholder="input" aria-label="input" />
            <Select aria-label="select">
              <option>one</option>
            </Select>
            <Textarea aria-label="textarea" placeholder="textarea" />
          </div>
        </Card>
      </Scene>
    </div>
  );
}

function publish(violations: Violation[]): void {
  const node = document.createElement("script");
  node.type = "application/json";
  node.id = VERDICT_ID;
  node.textContent = JSON.stringify({ ok: violations.length === 0, violations });
  document.body.appendChild(node);
}

const root = document.getElementById("root");
if (root) {
  createRoot(root).render(
    <StrictMode>
      <Probe />
    </StrictMode>,
  );
  // After paint: styles must be resolved before anything is measured, and the
  // sweep focuses real elements, so it cannot run inside render.
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      installProbeStyles();
      const violations = [...root.querySelectorAll("[data-scene]")].flatMap((scene) =>
        sweepFocusIndicators(scene, scene.getAttribute("data-scene") ?? "unnamed"),
      );
      publish(violations);
    });
  });
}
