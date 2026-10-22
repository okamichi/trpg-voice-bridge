import { test } from "node:test";
import assert from "node:assert/strict";
import { parseDelivery } from "./delivery.mjs";

test("word cues become v4-Large emoji in place; native emoji stay", () => {
  assert.deepEqual(parseDelivery("[感情:怒り]やめて！[演技:囁き]聞いて。😭"), {
    input: "😠やめて！👂聞いて。😭",
    caption: "",
  });
  assert.equal(
    parseDelivery(
      "[感情:怒り]やめてください。これ以上は許しません。[演技:囁き]誰かが来ました。",
    ).input,
    "😠やめてください。これ以上は許しません。👂誰かが来ました。",
  );
});
test("free cues go to the caption; ordinary parentheses and unknown tags stay spoken", () => {
  assert.deepEqual(
    parseDelivery("[演技:ためらいながら]（本当に？）[注釈:例]こんにちは。"),
    {
      input: "（本当に？）[注釈:例]こんにちは。",
      caption: "演技: ためらいながら",
    },
  );
});
test("round-bracket shorthand and free cues convert; ordinary parentheses stay", () => {
  const { input, caption } = parseDelivery(
    "（怒り）もう！怒ってるんだから！（演技：強い怒りをこめて）（本当に？）（囁き）聞いて。[感情:喜び]ありがとう。",
  );
  assert.equal(
    input,
    "😠もう！怒ってるんだから！（本当に？）👂聞いて。😆ありがとう。",
  );
  assert.equal(caption, "演技: 強い怒りをこめて");
  assert.equal(
    parseDelivery("（感情:悲しみ）さようなら。").input,
    "😭さようなら。",
  );
});
test("incomplete cues, empty bodies and oversized cues are rejected", () => {
  for (const text of [
    "[感情:怒り",
    "[演技:]本文",
    "[感情:通常]",
    `[演技:${"あ".repeat(101)}]本文`,
    "（演技：怒り",
    "（演技：）本文",
    "（通常）",
    `（演技：${"あ".repeat(101)}）本文`,
  ])
    assert.throws(() => parseDelivery(text), undefined, text);
});
