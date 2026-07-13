import { useEffect, useState } from 'preact/hooks';
import { type AudioProfileCatalog, setActiveAudioProfile, setAudioProfiles } from '../lib/api';
import { errorMessage } from '../lib/errors';
import { useTransact, useWritable } from '../lib/hooks';
import {
  addProfile,
  exportAudioProfileCatalog,
  parseAudioProfileCatalog,
  removeProfile,
  updateProfile,
} from '../lib/profiles';
import {
  audioProfileLimits,
  audioProfiles,
  config,
  loadDeviceSettings,
  status,
} from '../state/device';
import { Button } from './Button';
import { Card } from './Card';
import { Disclosure } from './Disclosure';
import { ActionState, TransactButton } from './Transact';

export function AudioProfiles() {
  const writable = useWritable();
  const transact = useTransact();
  const catalog = audioProfiles.value;
  const applied = config.value;
  const capabilities = status.value?.capabilities;
  const limits = audioProfileLimits.value;
  const [selectedId, setSelectedId] = useState('');
  const [name, setName] = useState('');
  const [sharedJson, setSharedJson] = useState('');

  useEffect(() => {
    if (!catalog) return;
    if (selectedId && catalog.profiles.some((profile) => profile.id === selectedId)) return;
    const fallback = catalog.active_profile_id ?? catalog.profiles[0]?.id ?? '';
    setSelectedId(fallback);
    setName(catalog.profiles.find((profile) => profile.id === fallback)?.name ?? '');
  }, [catalog, selectedId]);

  if (!catalog || !applied || !capabilities || !limits) return null;

  const currentCatalog = catalog;
  const currentConfig = applied;
  const currentCapabilities = capabilities;
  const currentLimits = limits;

  const selected = currentCatalog.profiles.find((profile) => profile.id === selectedId);
  const active = currentCatalog.profiles.find(
    (profile) => profile.id === currentCatalog.active_profile_id,
  );

  function choose(id: string) {
    setSelectedId(id);
    setName(currentCatalog.profiles.find((profile) => profile.id === id)?.name ?? '');
  }

  /**
   * Build the next catalog — which may reject the edit — then persist it and
   * re-read the device so the applied state and this form cannot drift.
   */
  function commitCatalog(
    build: () => AudioProfileCatalog,
    okText: (catalog: AudioProfileCatalog) => string,
  ) {
    let next: AudioProfileCatalog;
    try {
      next = build();
    } catch (error) {
      transact.setState({ text: errorMessage(error), cls: 'err' });
      return;
    }
    transact.run(
      async () => {
        const ack = await setAudioProfiles(next);
        await loadDeviceSettings();
        return ack;
      },
      { busyText: 'Saving profiles…', okText: okText(next) },
    );
  }

  function saveNew() {
    commitCatalog(
      () => {
        const edit = addProfile(currentCatalog, name, currentConfig, currentLimits);
        setSelectedId(edit.id);
        return edit.catalog;
      },
      () => `Saved ${name.trim()} — apply it when this source is selected`,
    );
  }

  function updateSelected() {
    if (!selected) return;
    const target = selected;
    commitCatalog(
      () => updateProfile(currentCatalog, target.id, name, currentConfig, currentLimits),
      () => `Updated ${name.trim()} from the current applied settings`,
    );
  }

  function deleteSelected() {
    if (!selected) return;
    const target = selected;
    commitCatalog(
      () => {
        const next = removeProfile(currentCatalog, target.id);
        setSelectedId('');
        setName('');
        return next;
      },
      () => `Deleted ${target.name}`,
    );
  }

  function applySelected() {
    if (!selected) return;
    const target = selected;
    transact.run(
      async () => {
        const ack = await setActiveAudioProfile(target.id);
        await loadDeviceSettings();
        return ack;
      },
      { busyText: `Applying ${target.name}…`, okText: `${target.name} is active` },
    );
  }

  function importCatalog() {
    commitCatalog(
      () => parseAudioProfileCatalog(sharedJson, currentCapabilities, currentLimits),
      (catalog) => `Imported ${catalog.profiles.length} profiles — current levels are unchanged`,
    );
  }

  return (
    <Card
      gated
      title="Source profiles"
      lead={
        <>
          Switch all input settings together. Active: <b>{active?.name ?? 'Custom settings'}</b>.
        </>
      }
    >
      <div class="profilegrid">
        <div class="field">
          <label for="audio_profile">Saved profile</label>
          <select
            id="audio_profile"
            disabled={!writable || currentCatalog.profiles.length === 0}
            value={selectedId}
            onChange={(event) => choose(event.currentTarget.value)}
          >
            {currentCatalog.profiles.length === 0 && <option value="">No profiles yet</option>}
            {currentCatalog.profiles.map((profile) => (
              <option key={profile.id} value={profile.id}>
                {profile.name}
              </option>
            ))}
          </select>
          <span class="help">Applying is instant and survives a restart.</span>
        </div>
        <div class="field">
          <label for="audio_profile_name">Profile name</label>
          <input
            id="audio_profile_name"
            type="text"
            maxlength={currentLimits.nameMaxChars}
            disabled={!writable}
            value={name}
            placeholder="Vinyl"
            onInput={(event) => setName(event.currentTarget.value)}
          />
          <span class="help">New profiles snapshot the applied settings below.</span>
        </div>
      </div>
      <div class="profileactions">
        <TransactButton
          transact={transact}
          disabled={!writable || !selected}
          onClick={applySelected}
        >
          Apply
        </TransactButton>
        <TransactButton transact={transact} kind="secondary" disabled={!writable} onClick={saveNew}>
          Save new
        </TransactButton>
        <TransactButton
          transact={transact}
          kind="secondary"
          disabled={!writable || !selected}
          onClick={updateSelected}
        >
          Update
        </TransactButton>
        <TransactButton
          transact={transact}
          kind="danger"
          disabled={!writable || !selected}
          onClick={deleteSelected}
        >
          Delete
        </TransactButton>
        <ActionState state={transact.state} />
      </div>
      <Disclosure title="Import or export profiles" className="profile-share">
        <p class="lead">
          Exported JSON is versioned and tied to this board. Import replaces saved profiles but
          never changes live levels.
        </p>
        <textarea
          aria-label="Audio profile catalog JSON"
          disabled={!writable}
          value={sharedJson}
          placeholder="Paste an exported profile catalog here"
          onInput={(event) => setSharedJson(event.currentTarget.value)}
        />
        <div class="profileactions">
          <Button
            disabled={!writable}
            onClick={() => setSharedJson(exportAudioProfileCatalog(currentCatalog))}
          >
            Show export
          </Button>
          <Button disabled={!writable || !sharedJson.trim()} onClick={importCatalog}>
            Import
          </Button>
        </div>
      </Disclosure>
    </Card>
  );
}
