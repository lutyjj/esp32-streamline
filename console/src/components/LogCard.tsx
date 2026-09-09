import { useEffect, useState } from 'preact/hooks';
import { useWritable } from '../lib/hooks';
import {
  type BootLogView,
  clearLogs,
  currentLog,
  FOLLOW_MS,
  hiddenLines,
  loadLogs,
  logsError,
  logsLoading,
  logText,
  previousLog,
} from '../state/logs';
import { Button } from './Button';
import { Card, CardFooter } from './Card';
import { CopyButton } from './CopyButton';
import { Disclosure } from './Disclosure';
import { Notice } from './Notice';
import { Toggle } from './Toggle';

/**
 * The device's own log, read over the API instead of through a serial cable.
 *
 * Opening the section reads once; following re-reads on a timer. The previous
 * boot's lines get their own subsection, because that is the reason to come
 * here after a device restarts on its own.
 */
export function LogCard() {
  const [open, setOpen] = useState(false);
  const [following, setFollowing] = useState(false);
  // The device gates this read behind the admin key, so the console can only
  // read it while it holds one.
  const authorized = useWritable();

  useEffect(() => {
    if (!open || !authorized) return;
    void loadLogs();
    if (!following) return;
    const timer = setInterval(() => void loadLogs(), FOLLOW_MS);
    return () => clearInterval(timer);
  }, [open, following, authorized]);

  return (
    <Card>
      <Disclosure
        title="Developer — device log"
        open={open}
        onToggle={(next) => {
          setOpen(next);
          if (!next) setFollowing(false);
        }}
      >
        {authorized ? <LogBody following={following} onFollow={setFollowing} /> : <LockedNotice />}
      </Disclosure>
    </Card>
  );
}

function LockedNotice() {
  return (
    <Notice>
      The device log names the network it joined and the hosts it talks to, so reading it needs the
      admin key. Unlock settings above to read it.
    </Notice>
  );
}

function LogBody({
  following,
  onFollow,
}: {
  following: boolean;
  onFollow: (next: boolean) => void;
}) {
  const current = currentLog.value;
  const previous = previousLog.value;
  return (
    <>
      {logsError.value && <Notice tone="error">{logsError.value}</Notice>}
      <LogLines
        title="This boot"
        view={current}
        empty="No lines captured yet — the device has been quiet since it started."
      />
      {previous && (
        <LogLines
          title="Before the last restart"
          view={previous}
          empty="The previous boot left no lines."
        />
      )}
      <CardFooter>
        <Toggle
          checked={following}
          onChange={onFollow}
          label="Follow"
          description={`Re-read every ${Math.round(FOLLOW_MS / 1000)} seconds while this section stays open.`}
        />
        <CopyButton value={logText(current)} copied="log copied">
          Copy this boot
        </CopyButton>
        <Button
          busy={logsLoading.value}
          onClick={() => {
            clearLogs();
            void loadLogs();
          }}
        >
          Clear and re-read
        </Button>
        <span class="actionstate">
          Same lines at <code>/api/logs</code>
        </span>
      </CardFooter>
    </>
  );
}

function LogLines({ title, view, empty }: { title: string; view: BootLogView; empty: string }) {
  const hidden = hiddenLines(view);
  return (
    <div class="card-subsection">
      <h3>{title}</h3>
      <div class="log apidump">
        {hidden > 0 && (
          <div class="dim">
            … {hidden} earlier {hidden === 1 ? 'line is' : 'lines are'} no longer held
          </div>
        )}
        {view.lines.length === 0 && <span class="dim">{empty}</span>}
        {view.lines.map((line) => (
          <div key={line.sequence}>{line.text}</div>
        ))}
      </div>
    </div>
  );
}
