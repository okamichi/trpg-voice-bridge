import { randomUUID } from "node:crypto";
import { check, voiceSchema } from "./contracts.mjs";

export function characterSettings(store) {
  return {
    characters: store.config.characters,
    voiceProfiles: store.config.voiceProfiles,
  };
}
// Compare only the edited character and shared voice, inside the same transaction.
export function saveCharacter(store, characterId, input) {
  let value;
  store.change((c) => {
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
    value = character;
  });
  return value;
}
