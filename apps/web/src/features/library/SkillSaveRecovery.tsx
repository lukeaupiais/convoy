import { useState } from 'react';
import { command, type RuntimeCommandInputMap } from '../../shared/api/runtime';

export function SkillSaveRecovery({
  target,
  disabled,
  onResolved,
  onError,
}: {
  target: RuntimeCommandInputMap['inspectSkillMutation'];
  disabled: boolean;
  onResolved: () => void;
  onError: (message: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [inspection, setInspection] = useState<{
    requestId?: string;
    digest: string | null;
    diagnostic?: string;
  } | null>(null);
  return (
    <div className="skill-revision-notice" role="status">
      <span>Save outcome is uncertain. Inspect before retrying.</span>
      <button
        type="button"
        className="secondary"
        disabled={disabled || busy}
        onClick={async () => {
          setBusy(true);
          try {
            const { result } = await command('inspectSkillMutation', target);
            setInspection({
              requestId: result.pending?.requestId,
              digest: result.current?.digest ?? null,
              diagnostic: result.diagnostic,
            });
            if (result.status === 'observed') onResolved();
          } catch (e) {
            onError((e as Error).message);
          } finally {
            setBusy(false);
          }
        }}
      >
        Inspect save
      </button>
      {inspection?.requestId && (
        <button
          type="button"
          className="secondary"
          disabled={disabled || busy}
          onClick={async () => {
            setBusy(true);
            try {
              await command('reconcileSkillMutation', {
                ...target,
                requestId: inspection.requestId!,
                expectedDigest: inspection.digest,
              });
              onResolved();
            } catch (e) {
              onError((e as Error).message);
            } finally {
              setBusy(false);
            }
          }}
        >
          Reconcile save
        </button>
      )}
      {inspection?.diagnostic && <span>{inspection.diagnostic}</span>}
    </div>
  );
}
