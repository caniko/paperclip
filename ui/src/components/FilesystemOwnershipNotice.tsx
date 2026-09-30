import type { HeartbeatRun } from "@paperclipai/shared";
import { InlineBanner } from "./InlineBanner";

interface FilesystemOwnershipNoticeProps {
  run: { status: string; filesystemOwnershipState?: HeartbeatRun["filesystemOwnershipState"] };
}

export function FilesystemOwnershipNotice({ run }: FilesystemOwnershipNoticeProps) {
  if (run.filesystemOwnershipState !== "waiting"
    || (run.status !== "queued" && run.status !== "running")) return null;
  return (
    <div role="status" aria-live="polite">
      <InlineBanner compact title="Waiting for exclusive filesystem ownership">
        Another run or its cleanup holds an overlapping directory. No agent work has started.
        You can cancel this run while it waits.
      </InlineBanner>
    </div>
  );
}
