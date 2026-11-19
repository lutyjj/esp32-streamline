import { useMutation, useQuery } from '@tanstack/preact-query';
import {
  Button,
  Card,
  CardBody,
  CardHead,
  CellSelect,
  FieldRow,
  Form,
  type FormErrors,
  SegmentedControl,
  SettingRow,
  TextField,
  useToast,
  useUnsavedChanges,
} from 'linen';
import { useRef, useState } from 'react';
import {
  type BoardSettingsRequest,
  type ButtonAction,
  getSetBoardUrl,
  type LedRole,
  setBoard,
} from '../../../generated/api';
import { FIELD_WIDTH } from '../../../shared/fieldWidth';
import { fieldErrors } from '../../../shared/http';
import { queryClient } from '../../../shared/queries';
import { ReadNotice } from '../../../shared/ReadNotice';
import { WriteConfirm } from '../../../shared/WriteConfirm';
import { WriteFailure } from '../../../shared/WriteFailure';
import { writeFailure } from '../../../shared/writeFailure';
import { BUTTON_ACTIONS, type ButtonRow, buttonRows, DESTRUCTIVE_ACTION } from '../../lib/buttons';
import { LED_ROLES, type LedRow, ledRows } from '../../lib/leds';
import { withRestart } from '../../state/access';
import { status } from '../../state/device';
import { assignButton, assignLed, nameProblem, renameDevice } from '../../state/hardware';
import { updateLock } from '../../state/ota';
import { boardsQuery, settingsQuery } from '../../state/queries';

const BUTTON_CHOICES = Object.entries(BUTTON_ACTIONS).map(([value, { label }]) => ({
  value,
  label,
}));
/** Every button's picker, wide enough for its longest action, so the pickers start on one edge. */
const ACTION_WIDTH = 56;
const LED_CHOICES = Object.entries(LED_ROLES).map(([value, { label }]) => ({
  value: value as LedRole,
  label,
}));

/** The device's name, its board, and what its buttons and lights do. */
export function HardwareSection() {
  const known = status.value;
  const settings = useQuery(settingsQuery, queryClient);
  if (!known) return null;
  const { buttons, leds } = known.capabilities;
  return (
    <>
      <NameCard saved={known.device_name} />
      <BoardCard />
      <ReadNotice read={settings} name="device settings" />
      {settings.data && buttons.length > 0 && (
        <ButtonsCard rows={buttonRows(buttons, settings.data.button_actions)} />
      )}
      {settings.data && leds.length > 0 && (
        <LightsCard rows={ledRows(leds, settings.data.led_roles)} />
      )}
    </>
  );
}

function NameCard({ saved }: { saved: string }) {
  // Null until edited, so a name changed elsewhere shows here.
  const [draft, setDraft] = useState<string | null>(null);
  const [errors, setErrors] = useState<FormErrors>({});
  const name = draft ?? saved;
  const unsaved = draft !== null && draft.trim() !== saved;
  const save = useMutation(
    {
      mutationFn: () => renameDevice(name),
      onSuccess: (done) => {
        setErrors({});
        if (done) setDraft(null);
      },
      onError: (error) => setErrors(fieldErrors(error, ['name'])),
    },
    queryClient,
  );
  useUnsavedChanges(unsaved, { name: 'the name', pending: save.isPending });
  return (
    <Card>
      <CardHead
        title="Identity"
        description="Tells this device apart in the rail and the browser tab. Left empty, the console says StreamLine."
      />
      <Form errors={errors} onSubmit={() => save.mutateAsync().catch(() => undefined)}>
        <CardBody>
          <FieldRow>
            <TextField
              label="Name"
              name="name"
              width={FIELD_WIDTH}
              autoComplete="off"
              placeholder="StreamLine"
              value={name}
              readOnly={save.isPending}
              validate={(value) => nameProblem(String(value ?? ''))}
              onChange={(event) => setDraft(event.currentTarget.value)}
            />
            <Button type="submit" busy={save.isPending} disabled={!unsaved}>
              Save
            </Button>
          </FieldRow>
          {save.error && Object.keys(errors).length === 0 && (
            <WriteFailure failed="The name did not change." error={save.error} />
          )}
        </CardBody>
      </Form>
    </Card>
  );
}

/** A board the owner asked to run as: a built-in one by id, or a board file. */
interface BoardChoice {
  request: BoardSettingsRequest;
  name: string;
}

function BoardCard() {
  const catalog = useQuery(boardsQuery, queryClient);
  const [asked, setAsked] = useState<BoardChoice | null>(null);
  const picker = useRef<HTMLInputElement>(null);
  // A board takes effect at a start, which waits while an update runs.
  const held = updateLock(getSetBoardUrl());
  if (!catalog.data) return <ReadNotice read={catalog} name="boards" />;
  const { boards, selected_board: selected, selected_board_id: selectedId } = catalog.data;
  const builtIn = boards.some((board) => board.board_id === selectedId);
  return (
    <Card>
      <CardHead
        title="Board"
        description="Its pins, codec, buttons and lights. The device reads them as it starts, so a change restarts it."
      />
      <SettingRow
        title={selected.board}
        description={held ?? (builtIn ? 'Built into this firmware.' : 'Loaded from a board file.')}
      >
        {(boards.length > 1 || !builtIn) && (
          <CellSelect
            aria-label="Board"
            placeholder="Choose a built-in board"
            choices={boards.map((board) => ({ value: board.board_id, label: board.board }))}
            value={builtIn ? selectedId : ''}
            disabled={held !== null}
            onValueChange={(id) => {
              const board = boards.find((entry) => entry.board_id === id);
              if (board) setAsked({ request: { board_id: id }, name: board.board });
            }}
          />
        )}
      </SettingRow>
      <SettingRow title="Codec">
        <span className="font-mono text-sm">{selected.codec.driver}</span>
      </SettingRow>
      <SettingRow
        title="Board file"
        description="Describes a board this firmware does not list, in the form of the built-in ones."
      >
        <Button disabled={held !== null} onClick={() => picker.current?.click()}>
          Load a board file
        </Button>
        <input
          ref={picker}
          type="file"
          accept="application/json,.json"
          hidden
          onChange={(event) => {
            const file = event.currentTarget.files?.[0];
            event.currentTarget.value = '';
            if (file) {
              void file
                .text()
                .then((descriptor) =>
                  setAsked({ request: { descriptor }, name: `the board in ${file.name}` }),
                );
            }
          }}
        />
      </SettingRow>
      <WriteConfirm
        open={asked !== null}
        onOpenChange={(open) => {
          if (!open) setAsked(null);
        }}
        title={`Run as ${asked?.name}?`}
        description="The device restarts to use its pins and codec, and audio stops until it is back."
        confirmLabel="Restart"
        failed="The device kept its board."
        write={() =>
          asked ? withRestart('the board', () => setBoard(asked.request)) : Promise.resolve()
        }
      />
    </Card>
  );
}

function ButtonsCard({ rows }: { rows: ButtonRow[] }) {
  const toast = useToast();
  const [resetAsked, setResetAsked] = useState<ButtonRow | null>(null);
  const assign = useMutation(
    {
      mutationFn: ({ id, action }: { id: string; action: ButtonAction }) =>
        assignButton(id, action),
      onError: (error) => {
        const words = writeFailure(error, 'The button kept its action.', 'device');
        toast.show({ text: `${words.title} ${words.description}`, sticky: true });
      },
    },
    queryClient,
  );
  return (
    <Card>
      <CardHead title="Buttons" description="What a press of each button on the board does." />
      {rows.map((row) => (
        <SettingRow
          key={row.id}
          title={row.label}
          description={
            row.action === DESTRUCTIVE_ACTION ? (
              <span className="text-warn">{BUTTON_ACTIONS[row.action].summary}</span>
            ) : (
              BUTTON_ACTIONS[row.action].summary
            )
          }
        >
          <CellSelect
            aria-label={`${row.label} action`}
            width={ACTION_WIDTH}
            choices={BUTTON_CHOICES}
            value={row.action}
            disabled={assign.isPending}
            onValueChange={(value) => {
              const action = value as ButtonAction;
              if (action === DESTRUCTIVE_ACTION) setResetAsked(row);
              else assign.mutate({ id: row.id, action });
            }}
          />
        </SettingRow>
      ))}
      <WriteConfirm
        open={resetAsked !== null}
        onOpenChange={(open) => {
          if (!open) setResetAsked(null);
        }}
        title={`Make ${resetAsked?.label} a factory reset button?`}
        description="One press then erases every setting, the Wi-Fi and the admin key with them, and the device returns to setup. Nothing asks first."
        confirmLabel="Make it factory reset"
        destructive
        failed="The button kept its action."
        write={() =>
          resetAsked ? assignButton(resetAsked.id, DESTRUCTIVE_ACTION) : Promise.resolve()
        }
      />
    </Card>
  );
}

function LightsCard({ rows }: { rows: LedRow[] }) {
  const toast = useToast();
  const assign = useMutation(
    {
      mutationFn: ({ id, role }: { id: string; role: LedRole }) => assignLed(id, role),
      onError: (error) => {
        const words = writeFailure(error, 'The light kept its role.', 'device');
        toast.show({ text: `${words.title} ${words.description}`, sticky: true });
      },
    },
    queryClient,
  );
  return (
    <Card>
      <CardHead title="Lights" description="What each light on the board shows." />
      {rows.map((row) => (
        <SettingRow key={row.id} title={row.label} description={LED_ROLES[row.role].summary}>
          <SegmentedControl
            label={row.label}
            value={row.role}
            options={LED_CHOICES}
            disabled={assign.isPending}
            onValueChange={(role) => assign.mutate({ id: row.id, role })}
          />
        </SettingRow>
      ))}
    </Card>
  );
}
