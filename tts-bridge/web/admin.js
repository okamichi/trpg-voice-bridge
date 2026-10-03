const $ = (id) => document.getElementById(id);
let config,
  token = "",
  voiceOptions = [],
  editing = null,
  diagnosticsBusy = false;
function notice(s) {
  $("notice").textContent = s;
}
async function api(path, method = "GET", data) {
  const r = await fetch(`/api/v1/admin/${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "Idempotency-Key": crypto.randomUUID(),
    },
    ...(data ? { body: JSON.stringify(data) } : {}),
  });
  if (!r.ok) {
    const b = await r.json();
    throw new Error(b.error ?? `HTTP ${r.status}`);
  }
  return r.headers.get("content-type")?.includes("audio/")
    ? r.blob()
    : r.json();
}
function run(fn) {
  let busy = false;
  return async (...args) => {
    args[0]?.preventDefault?.();
    if (busy) return;
    busy = true;
    const trigger = args[0]?.submitter ?? args[0]?.currentTarget;
    if (trigger?.tagName === "BUTTON") trigger.disabled = true;
    try {
      await fn(...args);
    } catch (e) {
      notice(e.message);
    } finally {
      busy = false;
      if (trigger?.tagName === "BUTTON") trigger.disabled = false;
    }
  };
}
const button = (text, fn, kind = "secondary") => {
  const b = document.createElement("button");
  b.textContent = text;
  b.type = "button";
  b.className = kind;
  b.onclick = run(fn);
  return b;
};
function line(parent, title, subtitle) {
  const div = document.createElement("div");
  div.className = "list-item";
  const strong = document.createElement("strong");
  strong.textContent = title;
  const small = document.createElement("p");
  small.className = "muted";
  small.textContent = subtitle;
  div.append(strong, small);
  parent.append(div);
  return div;
}
function input(parent, label, name, value = "", type = "text", options) {
  const l = document.createElement("label");
  l.textContent = label;
  const el = document.createElement(
    options ? "select" : type === "textarea" ? "textarea" : "input",
  );
  el.name = name;
  if (!options && type !== "textarea") el.type = type;
  if (options)
    for (const [v, t] of options) {
      const o = document.createElement("option");
      o.value = v;
      o.textContent = t;
      el.append(o);
    }
  if (type === "checkbox") el.checked = !!value;
  else el.value = value;
  l.append(el);
  parent.append(l);
  return el;
}
async function refresh() {
  config = await api("config");
  render();
  await diagnostics();
}
function render() {
  $("characters").replaceChildren();
  for (const ch of config.characters) {
    const row = line(
      $("characters"),
      ch.displayName,
      `${ch.enabled ? "有効" : "無効"} · ${config.voiceProfiles.find((v) => v.id === ch.voiceProfileId)?.name} · 紐付け ${ch.bindings.length} 件`,
    );
    row.append(
      button("編集", () => editCharacter(ch)),
      button("複製", () =>
        editCharacter({
          ...ch,
          id: null,
          displayName: `${ch.displayName} のコピー`,
          bindings: [],
        }),
      ),
      button(ch.enabled ? "無効化" : "有効化", async () => {
        await api(`characters/${ch.id}`, "PATCH", {
          revision: config.revision,
          value: { enabled: !ch.enabled },
        });
        await refresh();
      }),
      button(
        "削除",
        async () => {
          if (
            !confirm(
              `${ch.displayName}を削除し、未開始の音声を中止します。声は残ります。`,
            )
          )
            return;
          await api(`characters/${ch.id}`, "DELETE", {
            revision: config.revision,
          });
          await refresh();
        },
        "danger",
      ),
    );
  }
  $("voices").replaceChildren();
  for (const v of config.voiceProfiles) {
    const users = config.characters
      .filter((c) => c.voiceProfileId === v.id)
      .map((c) => c.displayName);
    const row = line(
      $("voices"),
      v.name,
      `版 ${v.revision} · 使用中: ${users.join("、") || "なし"}`,
    );
    row.append(
      button("編集・試聴", () => editVoice(v)),
      button("複製", () =>
        editVoice({ ...v, id: null, name: `${v.name} のコピー` }),
      ),
      button(
        "削除",
        async () => {
          if (
            !confirm(
              `${v.name}を削除します。使用キャラ: ${users.join("、") || "なし"}。参照音声は残ります。`,
            )
          )
            return;
          await api(`voice-profiles/${v.id}`, "DELETE", {
            revision: config.revision,
          });
          await refresh();
        },
        "danger",
      ),
    );
  }
  $("sources").replaceChildren();
  for (const s of config.sources) {
    line($("sources"), s.adapter, `${s.instanceId} / ${s.contextId}`).append(
      button("解除", async () => {
        await saveConfig({
          ...config,
          sources: config.sources.filter((x) => x !== s),
        });
      }),
    );
  }
  for (const key of ["baseUrl", "runtimeRevision", "type"])
    $("providerForm").elements[key].value = config.provider[key];
}
async function saveConfig(next) {
  config = await api("config", "PUT", next);
  render();
  notice("保存しました");
}
async function diagnostics() {
  if (diagnosticsBusy) return;
  diagnosticsBusy = true;
  try {
    await loadDiagnostics();
  } finally {
    diagnosticsBusy = false;
  }
}
async function loadDiagnostics() {
  const d = await api("diagnostics");
  $("sessionState").textContent = d.accepting ? "読み上げ中" : "停止中";
  $("diagnostics").replaceChildren();
  line(
    $("diagnostics"),
    "接続状態",
    `TTS: ${d.tts.status} · 待ち ${d.pending} · 生成 ${d.busy ? "実行中" : "なし"} · Player ${d.players.length} · 保管 ${(d.audioBytes / 1048576).toFixed(1)} MiB`,
  );
  if (d.tts.model) {
    const actual = d.tts.runtime?.checkpoint;
    line(
      $("diagnostics"),
      "モデル情報",
      `ロード: ${d.tts.runtime?.loaded ? "済" : "未"} · 読込先: ${actual ?? "未確定"} · HF既定値: ${d.tts.model.hf_checkpoint}（ローカル指定がある場合は読込先が優先）`,
    );
  }
  if (d.lastError) line($("diagnostics"), "生成エラー", d.lastError);
  for (const order of d.orders.slice(-5)) {
    const row = line(
      $("diagnostics"),
      order.speakerName,
      `#${order.orderSeq} · ${order.status}${order.error ? " · " + order.error : ""}`,
    );
    if (order.status === "ready")
      row.append(
        button("もう一度再生", async () => {
          await api("commands", "POST", {
            command: "replay",
            commandId: crypto.randomUUID(),
            orderId: order.orderId,
          });
          await diagnostics();
        }),
      );
  }
  for (const c of d.collectors)
    line(
      $("diagnostics"),
      `Collector ${c.source.adapter}`,
      `${c.online ? "接続中" : "切断"} · ${c.diagnostic}`,
    );
  for (const p of d.players) line($("diagnostics"), "Player", p.state);
  const unmapped = await api("unmapped-speakers");
  $("unmapped").replaceChildren();
  if (!unmapped.length)
    $("unmapped").textContent = "未登録の発言者はありません";
  for (const u of unmapped) {
    const binding = {
      ...u.source,
      ...(u.speaker.id
        ? { speakerId: u.speaker.id }
        : { alias: u.speaker.name, confirmUnique: true }),
    };
    const row = line(
      $("unmapped"),
      u.speaker.name,
      `${u.source.adapter} / ${u.source.contextId} · ${u.speaker.id ?? "表示名のみ。同名キャラの確認が必要"}`,
    );
    row.append(
      button("新規登録", () =>
        editCharacter({
          displayName: u.speaker.name,
          enabled: true,
          voiceProfileId: config.voiceProfiles[0]?.id,
          bindings: [binding],
        }),
      ),
      button("既存キャラへ紐付け", () => bindExisting(u, binding)),
      button("非表示", async () => {
        await api(`unmapped-speakers/${u.id}`, "DELETE");
        await diagnostics();
      }),
    );
  }
}
setInterval(() => {
  if (!token || document.hidden || $("editor").open) return;
  diagnostics().catch((error) => notice(error.message));
}, 5000);
document.addEventListener("visibilitychange", () => {
  if (!document.hidden && token && !$("editor").open)
    diagnostics().catch((error) => notice(error.message));
});
function openEditor(title) {
  $("editorTitle").textContent = title;
  $("fields").replaceChildren();
  $("preview").replaceChildren();
  $("editor").showModal();
}
function voiceFields(v = {}, prefix = "", f = $("fields")) {
  input(f, "名称", prefix + "name", v.name ?? "新しい声");
  input(f, "参照voice", prefix + "voiceId", v.voiceId ?? "none", "text", [
    ...new Map([
      ["none", "Voice Design（参照なし）"],
      ...voiceOptions.map((x) => [x.id, x.id]),
      ...(v.voiceId ? [[v.voiceId, v.voiceId]] : []),
    ]).entries(),
  ]);
  input(
    f,
    "話し方",
    prefix + "caption",
    v.caption ?? "自然で明瞭な日本語。",
    "textarea",
  );
  input(f, "速度（0.5～2）", prefix + "speed", v.speed ?? 1, "number");
  $("editForm").elements[prefix + "speed"].step = "0.05";
  input(f, "seed（64bit整数）", prefix + "seed", v.seed ?? "12345");
  input(f, "ステップ数（1～100）", prefix + "steps", v.steps ?? 10, "number");
  input(
    f,
    "参照音声の版",
    prefix + "referenceRevision",
    v.referenceRevision ?? 1,
    "number",
  );
  const details = document.createElement("details"),
    summary = document.createElement("summary");
  summary.textContent = "詳細設定（空欄はIrodoriの既定値）";
  details.append(summary);
  f.append(details);
  for (const [key, label] of [
    ["cfgScaleText", "本文のCFG強度"],
    ["cfgScaleCaption", "話し方のCFG強度"],
    ["cfgScaleSpeaker", "話者のCFG強度"],
  ]) {
    const field = input(
      details,
      label + "（0～10）",
      prefix + key,
      v[key] ?? "",
      "number",
    );
    field.min = "0";
    field.max = "10";
    field.step = "0.1";
  }
}
function readVoice(prefix = "") {
  const f = $("editForm").elements;
  return {
    id: editing?.original?.id ?? "preview",
    revision: editing?.original?.revision ?? 1,
    provider: "irodori-local",
    name: f[prefix + "name"].value,
    voiceId: f[prefix + "voiceId"].value,
    caption: f[prefix + "caption"].value,
    speed: Number(f[prefix + "speed"].value),
    seed: f[prefix + "seed"].value,
    steps: Number(f[prefix + "steps"].value),
    referenceRevision: Number(f[prefix + "referenceRevision"].value),
    ...Object.fromEntries(
      ["cfgScaleText", "cfgScaleCaption", "cfgScaleSpeaker"].map((key) => [
        key,
        f[prefix + key].value === "" ? null : Number(f[prefix + key].value),
      ]),
    ),
  };
}
function editVoice(v = {}) {
  editing = { type: "voice", original: v, revision: config.revision };
  openEditor("声の編集・試聴");
  voiceFields(v);
  const users = config.characters
    .filter((c) => c.voiceProfileId === v.id)
    .map((c) => c.displayName);
  const p = document.createElement("p");
  p.textContent = `変更の対象: ${users.join("、") || "なし"}`;
  $("fields").prepend(p);
  input($("preview"), "試聴するセリフ", "sample", "ここは私に任せてください。");
  $("preview").append(
    button("未保存の設定で試聴", async () => {
      notice("音声を生成しています…");
      const blob = await api("previews", "POST", {
        voice: readVoice(),
        text: $("editForm").elements.sample.value,
      });
      const a = document.createElement("audio");
      a.controls = true;
      a.src = URL.createObjectURL(blob);
      a.onended = () => URL.revokeObjectURL(a.src);
      $("preview").querySelector("audio")?.remove();
      $("preview").append(a);
      await a.play().catch(() => {});
      notice("試聴を生成しました。参加者へは配信されません");
    }),
  );
}
function editCharacter(ch = {}) {
  editing = {
    type: "character",
    original: ch,
    revision: config.revision,
    bindings: structuredClone(ch.bindings ?? []),
  };
  openEditor("キャラクターの登録");
  input($("fields"), "表示名", "displayName", ch.displayName ?? "");
  input($("fields"), "有効", "enabled", ch.enabled ?? true, "checkbox");
  const select = input(
    $("fields"),
    "声",
    "voiceProfileId",
    ch.voiceProfileId ?? config.voiceProfiles[0]?.id,
    "text",
    [
      ...config.voiceProfiles.map((v) => [v.id, v.name]),
      ["__new", "新しい声を同時登録"],
    ],
  );
  const holder = document.createElement("div");
  $("fields").append(holder);
  select.onchange = () => {
    holder.replaceChildren();
    if (select.value === "__new") {
      voiceFields({}, "new_", holder);
    }
  };
  if (select.value === "__new") select.onchange();
  const bindings = document.createElement("div");
  $("fields").append(bindings);
  for (const b of editing.bindings) {
    const row = line(
      bindings,
      b.speakerId ?? b.alias,
      `${b.adapter} / ${b.contextId}${b.tokenId ? " / Token " + b.tokenId : ""}`,
    );
    row.append(
      button("紐付け解除", () => {
        editing.bindings = editing.bindings.filter((x) => x !== b);
        row.remove();
      }),
    );
  }
  input(
    $("fields"),
    "表示名だけの紐付けは、部屋内に同名キャラがいないことを確認した",
    "unique",
    !editing.bindings.some((b) => b.alias),
    "checkbox",
  );
  const details = document.createElement("details"),
    summary = document.createElement("summary");
  summary.textContent = "外部IDを指定して紐付ける";
  details.append(summary);
  $("fields").append(details);
  input(details, "入力元", "bindingSource", "", "text", [
    ["", "選択しない"],
    ...config.sources.map((s, i) => [
      String(i),
      `${s.adapter} / ${s.instanceId} / ${s.contextId}`,
    ]),
  ]);
  input(details, "Actor・キャラID（または下の表示名）", "speakerId");
  input(details, "名前で紐付ける場合の表示名", "alias");
  input(details, "Token ID（上書き時のみ）", "tokenId");
  input(details, "Scene ID（Token上書き時のみ）", "sceneId");
}
function bindExisting(u, binding) {
  openEditor("既存キャラへ紐付け");
  editing = { type: "binding", binding, revision: config.revision };
  input(
    $("fields"),
    "キャラ",
    "characterId",
    config.characters[0]?.id,
    "text",
    config.characters.map((c) => [c.id, c.displayName]),
  );
  input(
    $("fields"),
    "表示名だけの場合、同名キャラがいないことを確認した",
    "unique",
    !!binding.speakerId,
    "checkbox",
  );
}
$("editForm").onsubmit = run(async (e) => {
  e.preventDefault();
  const f = e.target.elements,
    ed = editing;
  let path, value, newVoice;
  if (ed.type === "voice") {
    path = `voice-profiles${ed.original.id ? "/" + ed.original.id : ""}`;
    value = readVoice();
  } else if (ed.type === "binding") {
    const ch = config.characters.find((x) => x.id === f.characterId.value);
    if (!ch) throw new Error("先にキャラを登録してください");
    if (ed.binding.alias && !f.unique.checked)
      throw new Error("同名キャラを確認してください");
    path = `characters/${ch.id}`;
    value = { bindings: [...ch.bindings, ed.binding] };
  } else {
    const bindings = [...ed.bindings];
    if (f.bindingSource.value !== "") {
      const s = config.sources[Number(f.bindingSource.value)];
      bindings.push({
        ...s,
        ...(f.tokenId.value
          ? { tokenId: f.tokenId.value, sceneId: f.sceneId.value }
          : f.speakerId.value
            ? { speakerId: f.speakerId.value }
            : { alias: f.alias.value, confirmUnique: f.unique.checked }),
      });
    }
    if (bindings.some((b) => b.alias) && !f.unique.checked)
      throw new Error("同名キャラを確認してください");
    path = `characters${ed.original.id ? "/" + ed.original.id : ""}`;
    value = {
      displayName: f.displayName.value,
      enabled: f.enabled.checked,
      voiceProfileId: f.voiceProfileId.value,
      bindings,
    };
    if (f.voiceProfileId.value === "__new") newVoice = readVoice("new_");
  }
  await api(path, ed.original?.id || ed.type === "binding" ? "PATCH" : "POST", {
    revision: ed.revision,
    value,
    ...(newVoice ? { newVoice } : {}),
  });
  $("editor").close();
  await refresh();
  notice("保存しました");
});
$("cancel").onclick = () => $("editor").close();
$("newVoice").onclick = () => editVoice();
$("newCharacter").onclick = () => editCharacter();
$("loginButton").onclick = run(async () => {
  token = $("token").value;
  await refresh();
  $("token").value = "";
  $("login").hidden = true;
  $("workspace").hidden = false;
  notice("接続しました");
  voiceOptions = await api("providers/irodori-local/voices").catch(() => []);
});
$("refresh").onclick = run(diagnostics);
$("refreshVoices").onclick = run(async () => {
  voiceOptions = await api("providers/irodori-local/voices");
  notice(`${voiceOptions.length}件の参照voiceを取得しました`);
});
for (const b of document.querySelectorAll("[data-command]"))
  b.onclick = run(async () => {
    const command = b.dataset.command;
    if (
      ["end", "reset", "recover-provider"].includes(command) &&
      !confirm(b.textContent + "。実行しますか？")
    )
      return;
    const r = await api("commands", "POST", {
      command,
      commandId: crypto.randomUUID(),
    });
    if (r.url) {
      const a = document.createElement("a");
      a.href = r.url;
      a.target = "_blank";
      a.rel = "noopener";
      a.textContent = r.url;
      $("invite").replaceChildren(a);
    }
    await diagnostics();
  });
$("sourceForm").onsubmit = run(async (e) => {
  e.preventDefault();
  const f = e.target.elements;
  await saveConfig({
    ...config,
    sources: [
      ...config.sources,
      {
        adapter: f.adapter.value,
        instanceId: f.instanceId.value,
        contextId: f.contextId.value,
      },
    ],
  });
});
$("providerForm").onsubmit = run(async (e) => {
  e.preventDefault();
  const f = e.target.elements;
  await saveConfig({
    ...config,
    provider: {
      ...config.provider,
      baseUrl: f.baseUrl.value.replace(/\/$/, ""),
      runtimeRevision: f.runtimeRevision.value,
      type: f.type.value,
    },
  });
});
