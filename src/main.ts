import "katex/dist/katex.min.css";
import "highlight.js/styles/github-dark.min.css";
import "./styles.css";
import { mountApp } from "./ui/app";

/** Boots the static DeepReplica page once the DOM root is ready. */
async function boot(): Promise<void> {
  const root = document.getElementById("app");
  if (!root) {
    throw new Error("#app missing");
  }
  await mountApp(root);
}

void boot();
