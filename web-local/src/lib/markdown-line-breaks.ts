interface HastNode {
  type: string;
  tagName?: string;
  value?: string;
  children?: HastNode[];
}

/**
 * A Markdown hard line break (two spaces or a backslash before a newline)
 * becomes `<br>` followed by the newline itself. Chat paragraphs keep newlines
 * visible (`white-space: pre-wrap`), so that leftover newline drew a blank line
 * after every hard break, double-spacing dialogue, verse, and addresses. This
 * rehype plugin drops the newline so each break is one line (2026-10-27).
 */
export function rehypeSingleLineBreaks() {
  return (tree: HastNode) => {
    dropNewlinesAfterBreaks(tree);
  };
}

function dropNewlinesAfterBreaks(node: HastNode): void {
  const children = node.children;
  if (!children) return;
  children.forEach((child, index) => {
    const next = children[index + 1];
    if (child.type === "element" && child.tagName === "br" && next?.type === "text" && next.value?.startsWith("\n")) {
      next.value = next.value.slice(1);
    }
    dropNewlinesAfterBreaks(child);
  });
}
