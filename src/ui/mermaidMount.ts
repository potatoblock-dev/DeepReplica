import mermaid from "mermaid";

let initializedTheme: "dark" | "default" | null = null;

/** Resolves the effective light/dark theme from the document root. */
function resolvedMermaidTheme(): "dark" | "default" {
  const theme = document.documentElement.dataset.theme;
  return theme === "light" ? "default" : "dark";
}

/** Initializes or re-initializes mermaid when the app theme changes. */
function ensureMermaidInit(): void {
  const theme = resolvedMermaidTheme();
  if (initializedTheme === theme) {
    return;
  }
  mermaid.initialize({
    startOnLoad: false,
    securityLevel: "strict",
    theme,
    fontFamily: "inherit",
  });
  initializedTheme = theme;
}

/**
 * Renders any pending `.mermaid` nodes under `root`.
 * Idempotent for already-processed nodes; failed diagrams keep source + error class.
 */
export async function mountMermaid(root: ParentNode = document): Promise<void> {
  const nodes = Array.from(root.querySelectorAll<HTMLElement>(".mermaid")).filter(
    (el) => el.getAttribute("data-processed") !== "true",
  );
  if (nodes.length === 0) {
    return;
  }
  ensureMermaidInit();
  try {
    await mermaid.run({ nodes });
  } catch {
    for (const node of nodes) {
      if (node.getAttribute("data-processed") === "true") {
        continue;
      }
      node.classList.add("mermaid-error");
      if (!node.querySelector(".mermaid-error-hint")) {
        const hint = document.createElement("div");
        hint.className = "mermaid-error-hint";
        hint.textContent = "Mermaid 图表渲染失败（可能仍在流式输出中）";
        node.parentElement?.appendChild(hint);
      }
    }
  }
}

/** Forces mermaid to pick up a new theme on the next mount. */
export function resetMermaidTheme(): void {
  initializedTheme = null;
}
