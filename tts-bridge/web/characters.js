const $ = (id) => document.getElementById(id);
let room,
  data,
  before,
  voiceBefore,
  previewUrl,
  previewId,
  generation = 0;
const dialog = $("characterEditor"),
  form = $("characterForm");
const fields = [
  "name",
  "voiceId",
  "caption",
  "speed",
  "seed",
  "steps",
  "cfgScaleText",
  "cfgScaleCaption",
  "cfgScaleSpeaker",
];
async function request(path, method = "GET", body) {
  const r = await fetch(`/api/v1/rooms/${room}/${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      "Idempotency-Key": crypto.randomUUID(),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  if (!r.ok) throw new Error((await r.json()).error);
  return r;
}
export async function refreshCharacters(roomId = room) {
  if (!roomId) return;
  room = roomId;
  try {
    data = await (await request("characters")).json();
    const list = $("characters");
    list.replaceChildren();
    if (!data.characters.length) {
      list.textContent =
        "VTTでキャラとして公開発言すると、ここに表示されます。読み上げ停止中でも設定できます。";
      return;
    }
    const chars = [...data.characters].sort(
      (a, b) =>
        Number(!!a.voiceProfileId) - Number(!!b.voiceProfileId) ||
        a.displayName.localeCompare(b.displayName, "ja"),
    );
    for (const ch of chars) {
      const row = document.createElement("div");
      row.className = "list-item";
      const name = document.createElement("strong");
      name.textContent = ch.displayName;
      const voice = document.createElement("span");
      voice.className = "badge";
      voice.textContent =
        data.voiceProfiles.find((v) => v.id === ch.voiceProfileId)?.name ??
        "声が未設定";
      const info = document.createElement("small");
      info.textContent = ch.bindings
        .map(
          (b) =>
            `${b.adapter} / ${b.contextId} / ${b.tokenId ?? b.speakerId ?? b.alias}`,
        )
        .join("、");
      const button = document.createElement("button");
      button.textContent = ch.voiceProfileId ? "試聴・変更" : "声を選ぶ";
      button.onclick = () => edit(ch);
      row.append(
        name,
        " ",
        voice,
        document.createElement("br"),
        info,
        document.createElement("br"),
        button,
      );
      list.append(row);
    }
  } catch (e) {
    $("characterStatus").textContent = e.message;
  }
}
function loadVoice() {
  const v = data.voiceProfiles.find((v) => v.id === form.elements.voice.value);
  voiceBefore = v ? structuredClone(v) : null;
  const values = v ?? {
    name: `${before.displayName}の声`,
    voiceId: "none",
    caption: "",
    speed: 1,
    seed: "1",
    steps: 20,
  };
  for (const key of fields) form.elements[key].value = values[key] ?? "";
  const users = data.characters
    .filter((c) => c.voiceProfileId === v?.id)
    .map((c) => c.displayName);
  $("voiceUsers").textContent = users.length
    ? `この声の編集は、使用中の全キャラ（${users.join("、")}）に反映されます。`
    : "新しい声を作成します。保存後は他のキャラも選べます。";
}
async function edit(ch) {
  generation++;
  before = structuredClone(ch);
  $("editorStatus").textContent = "";
  form.elements.displayName.value = ch.displayName;
  form.elements.enabled.checked = ch.enabled;
  form.elements.voice.replaceChildren(
    ...data.voiceProfiles.map((v) => new Option(v.name, v.id)),
    new Option("＋ 新しい声を作る", "new"),
  );
  form.elements.voice.value =
    ch.voiceProfileId ?? data.voiceProfiles[0]?.id ?? "new";
  loadVoice();
  dialog.showModal();
  const current = generation;
  try {
    await refreshReferenceVoices(current);
  } catch (e) {
    $("editorStatus").textContent =
      `参照音声一覧を取得できません。既存の設定は利用できます。${e.message}`;
  }
}
async function refreshReferenceVoices(current) {
  const voices = await (await request("voices")).json();
  if (current !== generation) return;
  $("referenceVoices").replaceChildren(
    ...voices.map((v) => new Option(v.id, v.id)),
  );
}
function voiceValue() {
  const v = { id: voiceBefore?.id ?? "new", provider: "irodori-local" };
  for (const key of fields) {
    const value = form.elements[key].value;
    if (key.startsWith("cfg") && value === "") continue;
    v[key] = [
      "speed",
      "steps",
      "cfgScaleText",
      "cfgScaleCaption",
      "cfgScaleSpeaker",
    ].includes(key)
      ? Number(value)
      : value;
  }
  return v;
}
form.elements.voice.onchange = loadVoice;
form.onsubmit = async (e) => {
  e.preventDefault();
  $("saveCharacter").disabled = true;
  try {
    const voice = voiceValue();
    const comparable = (v) =>
      JSON.stringify(
        Object.keys(v)
          .sort()
          .map((k) => [k, v[k]]),
      );
    const voiceChanged =
      !voiceBefore || comparable(voice) !== comparable(voiceBefore);
    await request(`characters/${before.id}`, "PATCH", {
      before,
      value: {
        displayName: form.elements.displayName.value,
        enabled: form.elements.enabled.checked,
        voiceProfileId: voiceBefore?.id ?? null,
      },
      ...(voiceChanged ? { voice, voiceBefore } : {}),
    });
    dialog.close();
    $("characterStatus").textContent =
      "保存しました。次の新しい発言から反映します。";
    await refreshCharacters();
  } catch (e) {
    $("editorStatus").textContent = e.message;
  } finally {
    $("saveCharacter").disabled = false;
  }
};
$("previewVoice").onclick = async () => {
  const current = generation;
  $("previewVoice").disabled = true;
  $("editorStatus").textContent = "試聴音声を生成しています…";
  try {
    const response = await request("previews", "POST", {
      voice: voiceValue(),
      text: form.elements.sample.value,
    });
    const blob = await response.blob();
    if (current !== generation || !dialog.open) return;
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    previewUrl = URL.createObjectURL(blob);
    previewId = response.headers.get("X-Preview-Id");
    $("referenceRegister").hidden = !previewId;
    if (!form.elements.referenceId.value) {
      const d = new Date(),
        p = (n) => String(n).padStart(2, "0");
      form.elements.referenceId.value = `voice-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
    }
    $("previewAudio").src = previewUrl;
    $("editorStatus").textContent = "この試聴はあなたにだけ再生されます。";
    await $("previewAudio").play();
  } catch (e) {
    if (current === generation) $("editorStatus").textContent = e.message;
  } finally {
    $("previewVoice").disabled = false;
  }
};
$("registerReference").onclick = async () => {
  const current = generation,
    voiceId = form.elements.referenceId.value.trim();
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(voiceId)) {
    $("editorStatus").textContent =
      "参照音声IDは英数字・_・-の64文字以内で入力してください。";
    return;
  }
  $("registerReference").disabled = true;
  $("editorStatus").textContent = "参照音声を登録しています…";
  try {
    await request("voices", "POST", { previewId, voiceId });
    if (current !== generation) return;
    await refreshReferenceVoices(current);
    form.elements.voiceId.value = voiceId;
    $("referenceRegister").hidden = true;
    $("editorStatus").textContent =
      `参照音声「${voiceId}」を登録しました。保存すると、この声に使われます。`;
  } catch (e) {
    if (current === generation) $("editorStatus").textContent = e.message;
  } finally {
    $("registerReference").disabled = false;
  }
};
$("cancelCharacter").onclick = () => dialog.close();
dialog.onclose = () => {
  generation++;
  $("previewAudio").pause();
  $("previewAudio").removeAttribute("src");
  if (previewUrl) URL.revokeObjectURL(previewUrl);
  previewUrl = null;
  previewId = null;
  $("referenceRegister").hidden = true;
  form.elements.referenceId.value = "";
};
setInterval(() => {
  if (room && document.visibilityState === "visible") refreshCharacters();
}, 5000);
