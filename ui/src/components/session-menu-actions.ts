export function simpleSessionMenuAction(value: string) {
  switch (value) {
    case "copy-session-id":
    case "toggle-unread":
    case "rename":
    case "fork":
    case "workboard":
    case "new-group":
    case "toggle-archived":
    case "stop-cloud-worker":
    case "delete":
      return { kind: value };
    default:
      return undefined;
  }
}
