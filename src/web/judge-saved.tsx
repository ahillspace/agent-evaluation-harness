import type { WorkspaceView } from "../contracts.js";
import { useResource } from "./api.js";
import { AssessmentDialog } from "./assessment-dialog.js";
import { ErrorNotice, Modal } from "./ui.js";

export function JudgeSavedAnswers({
  runId,
  workspace,
  onClose,
  onSaved,
}: {
  runId: string;
  workspace: WorkspaceView;
  onClose: () => void;
  onSaved: () => void;
}) {
  const resource = useResource("runs.get", { runId });
  return resource.data ? (
    <AssessmentDialog
      view={resource.data}
      workspace={workspace}
      onClose={onClose}
      onSaved={() => {
        onSaved();
        onClose();
      }}
    />
  ) : (
    <Modal title="Score saved answers" onClose={onClose}>
      <ErrorNotice error={resource.error} />
      <p>Loading saved answers...</p>
    </Modal>
  );
}
