import { useQuery } from '@tanstack/preact-query';
import {
  Button,
  Card,
  CardBody,
  CardHead,
  Content,
  EmptyState,
  PromptDialog,
  SettingRow,
  useToast,
} from 'linen';
import { useRef, useState } from 'react';
import type { AudioProfile, AudioProfileCatalog, StatusResponse } from '../../../generated/api';
import { fieldErrors } from '../../../shared/http';
import { queryClient } from '../../../shared/queries';
import { ReadNotice } from '../../../shared/ReadNotice';
import { saveFile } from '../../../shared/saveFile';
import { WriteConfirm } from '../../../shared/WriteConfirm';
import { writeFailure } from '../../../shared/writeFailure';
import { status } from '../../state/device';
import {
  deleteProfile,
  exportProfiles,
  importProfiles,
  renameProfile,
  replaceProfile,
  saveProfile,
} from '../../state/profiles';
import { audioProfilesQuery } from '../../state/queries';
import { ScreenTop } from '../ScreenTop';
import { levelsWords } from './levelsWords';

const TRAIL = [{ href: '/audio', label: 'Audio' }];

/** What the screen is asking about, one question at a time. */
type Ask =
  | { kind: 'save' }
  | { kind: 'rename'; profile: AudioProfile }
  | { kind: 'update'; profile: AudioProfile }
  | { kind: 'delete'; profile: AudioProfile }
  | { kind: 'import'; text: string; file: string };

/**
 * Profiles: keep the applied levels under a name, change or remove what is
 * kept, and move every profile in a file. Choosing one stays on Audio.
 */
export function ProfilesScreen() {
  const read = useQuery(audioProfilesQuery, queryClient);
  const catalog = read.data;
  const known = status.value;
  return (
    <>
      <ScreenTop title="Profiles" trail={TRAIL} />
      <Content>
        {catalog && known ? (
          <Profiles catalog={catalog} known={known} />
        ) : (
          <ReadNotice read={read} name="audio profiles" />
        )}
      </Content>
    </>
  );
}

function Profiles({ catalog, known }: { catalog: AudioProfileCatalog; known: StatusResponse }) {
  const [ask, setAsk] = useState<Ask | null>(null);
  const lines = known.capabilities.input_lines;
  const applied = levelsWords(known.audio, lines);
  const saveLevels = (
    <Button variant="primary" onClick={() => setAsk({ kind: 'save' })}>
      Save applied levels
    </Button>
  );
  return (
    <div className="grid gap-4">
      <Card>
        <CardHead
          title="Saved profiles"
          description={`Saving keeps the applied levels: ${applied}.`}
        >
          {catalog.profiles.length > 0 && saveLevels}
        </CardHead>
        {catalog.profiles.length === 0 ? (
          <EmptyState
            title="No profiles yet"
            description="A profile keeps an input, gain and attenuation under a name, to switch back to them on Audio."
          >
            {saveLevels}
          </EmptyState>
        ) : (
          // biome-ignore lint/a11y/useSemanticElements: SettingRow is a div with the listitem role, which a <ul> may not hold.
          <div role="list" aria-label="Saved profiles">
            {catalog.profiles.map((profile) => (
              <SettingRow
                key={profile.id}
                role="listitem"
                title={
                  profile.id === catalog.active_profile_id
                    ? `${profile.name} · in use`
                    : profile.name
                }
                description={levelsWords(profile.audio, lines)}
              >
                <div className="flex flex-wrap gap-2">
                  <Button onClick={() => setAsk({ kind: 'rename', profile })}>Rename</Button>
                  <Button onClick={() => setAsk({ kind: 'update', profile })}>Update</Button>
                  <Button variant="destructive" onClick={() => setAsk({ kind: 'delete', profile })}>
                    Delete
                  </Button>
                </div>
              </SettingRow>
            ))}
          </div>
        )}
      </Card>
      <MoveProfiles
        board={catalog.board_id}
        empty={catalog.profiles.length === 0}
        onImport={(text, file) => setAsk({ kind: 'import', text, file })}
      />
      <Questions
        ask={ask}
        applied={applied}
        saved={catalog.profiles.length}
        onDone={() => setAsk(null)}
      />
    </div>
  );
}

/** Every profile in a file: to keep it, or to load it on another device of this board. */
function MoveProfiles({
  board,
  empty,
  onImport,
}: {
  board: string;
  empty: boolean;
  onImport: (text: string, file: string) => void;
}) {
  const picker = useRef<HTMLInputElement>(null);
  const download = () =>
    saveFile(
      new Blob([exportProfiles()], { type: 'application/json' }),
      `streamline-profiles-${board}.json`,
    );
  return (
    <Card>
      <CardHead
        title="Profile file"
        description="Every profile in one file, to keep or to load on another device with this board. Loading one replaces the saved profiles and applies none of them."
      />
      <CardBody>
        <div className="flex flex-wrap gap-2">
          <Button disabled={empty} onClick={download}>
            Export
          </Button>
          <Button onClick={() => picker.current?.click()}>Import</Button>
          <input
            ref={picker}
            type="file"
            accept="application/json,.json"
            hidden
            onChange={(event) => {
              const file = event.currentTarget.files?.[0];
              event.currentTarget.value = '';
              if (file) void file.text().then((text) => onImport(text, file.name));
            }}
          />
        </div>
      </CardBody>
    </Card>
  );
}

function Questions({
  ask,
  applied,
  saved,
  onDone,
}: {
  ask: Ask | null;
  applied: string;
  saved: number;
  onDone: () => void;
}) {
  const toast = useToast();
  const [refusal, setRefusal] = useState('');
  // The device's refusal of the catalog stays on the name it was sent with;
  // any other failure closes the question, and the toast says what it was.
  const named = (act: (name: string) => Promise<boolean>) => async (name: string) => {
    try {
      await act(name);
      setRefusal('');
      onDone();
    } catch (error) {
      const refused = fieldErrors(error, ['catalog']).catalog;
      setRefusal(refused ?? '');
      if (refused) return;
      onDone();
      const words = writeFailure(error, 'The profiles did not change.', 'device');
      toast.show({ text: `${words.title} ${words.description}`, sticky: true });
    }
  };
  const closed = (open: boolean) => {
    if (open) return;
    setRefusal('');
    onDone();
  };
  return (
    <>
      <PromptDialog
        open={ask?.kind === 'save'}
        title="Save the applied levels"
        label="Name"
        placeholder="Living room"
        confirmLabel="Save"
        error={refusal || undefined}
        onOpenChange={closed}
        onConfirm={named(saveProfile)}
      />
      <PromptDialog
        open={ask?.kind === 'rename'}
        title="Rename the profile"
        label="Name"
        placeholder="Living room"
        defaultValue={ask?.kind === 'rename' ? ask.profile.name : undefined}
        confirmLabel="Rename"
        error={refusal || undefined}
        onOpenChange={closed}
        onConfirm={named((name) =>
          ask?.kind === 'rename' ? renameProfile(ask.profile.id, name) : Promise.resolve(false),
        )}
      />
      <WriteConfirm
        open={ask?.kind === 'update'}
        onOpenChange={closed}
        title={ask?.kind === 'update' ? `Give ${ask.profile.name} the applied levels?` : ''}
        description={`It keeps its name and takes ${applied}.`}
        confirmLabel="Update"
        failed="The profile did not change."
        write={() => (ask?.kind === 'update' ? replaceProfile(ask.profile.id) : Promise.resolve())}
      />
      <WriteConfirm
        open={ask?.kind === 'delete'}
        onOpenChange={closed}
        title={ask?.kind === 'delete' ? `Delete ${ask.profile.name}?` : ''}
        description="The levels the device uses stay as they are."
        confirmLabel="Delete"
        destructive
        failed="The profile was not deleted."
        write={() => (ask?.kind === 'delete' ? deleteProfile(ask.profile.id) : Promise.resolve())}
      />
      <WriteConfirm
        open={ask?.kind === 'import'}
        onOpenChange={closed}
        title="Replace the saved profiles?"
        description={
          ask?.kind === 'import'
            ? `The profiles in ${ask.file} take the place of the ${saved} saved now. None of them is applied.`
            : ''
        }
        confirmLabel="Replace"
        destructive
        failed="The profiles were not loaded."
        write={() => (ask?.kind === 'import' ? importProfiles(ask.text) : Promise.resolve())}
      />
    </>
  );
}
