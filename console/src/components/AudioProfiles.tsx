import { useEffect, useState } from 'preact/hooks';
import { setActiveAudioProfile, setAudioProfiles } from '../lib/api';
import { useTransact, useWritable } from '../lib/hooks';
import {
  exportAudioProfileCatalog,
  nextProfileId,
  parseAudioProfileCatalog,
  profileFromConfig,
} from '../lib/profiles';
import {
  audioProfileLimits,
  audioProfiles,
  config,
  loadDeviceSettings,
  status,
} from '../state/device';
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

  function runCatalogWrite(next: typeof currentCatalog, okText: string) {
    transact.run(
      async () => {
        const ack = await setAudioProfiles(next);
        await loadDeviceSettings();
        return ack;
      },
      { busyText: 'Saving profiles…', okText },
    );
  }

  function saveNew() {
    const trimmed = name.trim();
    if (!trimmed) {
      transact.setState({ text: 'Enter a profile name', cls: 'err' });
      return;
    }
    if ([...trimmed].length > currentLimits.nameMaxChars) {
      transact.setState({
        text: `Profile names are limited to ${currentLimits.nameMaxChars} characters`,
        cls: 'err',
      });
      return;
    }
    if (currentCatalog.profiles.length >= currentLimits.maxProfiles) {
      transact.setState({
        text: `This device stores up to ${currentLimits.maxProfiles} profiles`,
        cls: 'err',
      });
      return;
    }
    const id = nextProfileId(
      trimmed,
      currentCatalog.profiles.map((profile) => profile.id),
    );
    runCatalogWrite(
      {
        ...currentCatalog,
        profiles: [...currentCatalog.profiles, profileFromConfig(id, trimmed, currentConfig)],
      },
      `Saved ${trimmed} — apply it when this source is selected`,
    );
    setSelectedId(id);
  }

  function updateSelected() {
    if (!selected) return;
    const trimmed = name.trim();
    if (!trimmed || [...trimmed].length > currentLimits.nameMaxChars) {
      transact.setState({ text: 'Enter a profile name of 1–32 characters', cls: 'err' });
      return;
    }
    runCatalogWrite(
      {
        ...currentCatalog,
        profiles: currentCatalog.profiles.map((profile) =>
          profile.id === selected.id
            ? profileFromConfig(profile.id, trimmed, currentConfig)
            : profile,
        ),
      },
      `Updated ${trimmed} from the current applied settings`,
    );
  }

  function deleteSelected() {
    if (!selected) return;
    runCatalogWrite(
      {
        ...currentCatalog,
        active_profile_id:
          currentCatalog.active_profile_id === selected.id
            ? null
            : currentCatalog.active_profile_id,
        profiles: currentCatalog.profiles.filter((profile) => profile.id !== selected.id),
      },
      `Deleted ${selected.name}`,
    );
    setSelectedId('');
    setName('');
  }

  function applySelected() {
    if (!selected) return;
    transact.run(
      async () => {
        const ack = await setActiveAudioProfile(selected.id);
        await loadDeviceSettings();
        return ack;
      },
      { busyText: `Applying ${selected.name}…`, okText: `${selected.name} is active` },
    );
  }

  function importCatalog() {
    try {
      const imported = parseAudioProfileCatalog(sharedJson, currentCapabilities, currentLimits);
      runCatalogWrite(
        imported,
        `Imported ${imported.profiles.length} profiles — current levels are unchanged`,
      );
    } catch (error) {
      transact.setState({
        text: error instanceof Error ? error.message : String(error),
        cls: 'err',
      });
    }
  }

  return (
    <div class="card gated">
      <span class="lockhint">Unlock to edit</span>
      <h2>Source profiles</h2>
      <p class="lead">
        Switch all input settings together. Active: <b>{active?.name ?? 'Custom settings'}</b>.
      </p>
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
          <button
            class="btn secondary"
            type="button"
            disabled={!writable}
            onClick={() => setSharedJson(exportAudioProfileCatalog(currentCatalog))}
          >
            Show export
          </button>
          <button
            class="btn secondary"
            type="button"
            disabled={!writable || !sharedJson.trim()}
            onClick={importCatalog}
          >
            Import
          </button>
        </div>
      </Disclosure>
    </div>
  );
}
