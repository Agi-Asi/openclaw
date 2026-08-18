export type ApprovalDeliveryDiagnosticEvent = Readonly<
  Record<string, unknown> & { stage: string }
>;

let diagnosticSink: ((event: ApprovalDeliveryDiagnosticEvent) => void) | undefined;

export function setApprovalDeliveryDiagnosticSinkForTest(
  sink: ((event: ApprovalDeliveryDiagnosticEvent) => void) | undefined,
): void {
  diagnosticSink = sink;
}

export function emitApprovalDeliveryDiagnostic(event: ApprovalDeliveryDiagnosticEvent): void {
  diagnosticSink?.(event);
}
