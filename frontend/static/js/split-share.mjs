// Which document the Publish and X Article actions belong to.
// In a single pane they stay on the primary document. In the split pair
// (left `name.c.md`, right `name.md`) the right pane gets the same actions
// for the right document, and the left pane keeps its own.

export function conversationPair({ splitOpen, left, right }) {
  return !!splitOpen && !!left && !!right &&
    left.projectId === right.projectId &&
    left.sessionId === right.sessionId &&
    typeof right.filename === "string" && right.filename.endsWith(".md") &&
    left.filename === right.filename.slice(0, -3) + ".c.md";
}

export function paneShareState({ pane, splitOpen, left, right, streaming, blockedRoles }) {
  const doc = pane === "right" ? right : left;
  const allowed = pane === "right" ? conversationPair({ splitOpen, left, right }) : true;
  const publishable = !!allowed && !!doc && !blockedRoles.has(doc.role);
  return {
    visible: publishable,
    disabled: !publishable || !!streaming,
    published: publishable && !!doc.publishToken,
    labelKey: publishable && doc.publishToken ? "editor.publishing" : "editor.publish",
    target: publishable ? {
      projectId: doc.projectId,
      sessionId: doc.sessionId,
      filename: doc.filename,
      publishToken: doc.publishToken || null,
    } : null,
  };
}
