import { NEW_VOICE_DEFAULTS } from "./voice-defaults.mjs";
import { randomUUID } from "node:crypto";
import { check, voiceSchema } from "./contracts.mjs";

export function characterSettings(store) {
  return {
    characters: store.config.characters,
    voiceDefaults: NEW_VOICE_DEFAULTS,
    voiceStates: store.voiceCommands.states(),
    voiceProfiles: store.config.voiceProfiles,
  };
}
// Compare only the edited character and shared voice, inside the same transaction.
export function saveCharacter(store, characterId, input) {
  let value;
  store.change((c) => {
    store.voiceCommands.assertIdle(characterId);
    const character = c.characters.find((x) => x.id === characterId);
    check(character, "キャラが見つかりません", 404);
    store.compare(character, input.before);
    check(
      input.value &&
        Object.keys(input.value).every((k) =>
          ["displayName", "enabled", "voiceProfileId"].includes(k),
        ),
      "変更できない項目です",
    );
    let voiceId = Object.hasOwn(input.value, "voiceProfileId")
      ? input.value.voiceProfileId
      : character.voiceProfileId;
    if (input.voice) {
      const v = structuredClone(input.voice);
      if (input.voiceBefore === null) {
        v.id = randomUUID();
        c.voiceProfiles.push(v);
      } else {
        const index = c.voiceProfiles.findIndex((x) => x.id === v.id);
        check(index >= 0, "声が削除されています", 409);
        store.compare(c.voiceProfiles[index], input.voiceBefore);
        c.voiceProfiles[index] = v;
      }
      voiceSchema(v);
      voiceId = v.id;
    }
    Object.assign(character, input.value, { voiceProfileId: voiceId });
    store.voiceCommands.clear(characterId);
    value = character;
  });
  return value;
}

export function removeCharacter(store, characterId, input) {
  let value;
  store.change((c) => {
    store.voiceCommands.assertIdle(characterId);
    const index = c.characters.findIndex((x) => x.id === characterId);
    check(index >= 0, "キャラが見つかりません", 404);
    store.compare(c.characters[index], input.before);
    [value] = c.characters.splice(index, 1);
    store.voiceCommands.clear(characterId);
  });
  return value;
}

export function removeVoiceProfile(store, voiceId, input, additionalUses = {}) {
  let value;
  store.change((c) => {
    const index = c.voiceProfiles.findIndex((v) => v.id === voiceId);
    check(index >= 0, "声が見つかりません", 404);
    store.compare(c.voiceProfiles[index], input.before);
    check(
      !c.characters.some((ch) => ch.voiceProfileId === voiceId) &&
        !additionalUses[voiceId]?.length,
      "この声は使用中です。割り当てを解除してから削除してください",
      409,
    );
    [value] = c.voiceProfiles.splice(index, 1);
  });
  return value;
}
