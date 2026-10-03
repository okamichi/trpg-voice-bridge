// These aliases use the v4-Large checkpoint's EMOJI_ANNOTATIONS.md.
// Keep native emoji in the input: they are model conditioning, not spoken labels.
export const DELIVERY_EMOJI = Object.freeze({
  通常: '',
  喜び: '😆',
  怒り: '😠',
  悲しみ: '😭',
  驚き: '😲',
  心配: '😟',
  緊張: '😰',
  安堵: '😌',
  自信: '😎',
  照れ: '🫣',
  囁き: '👂',
  ささやき: '👂',
  小声: '👂',
  優しく: '🫶',
  笑い: '🤭',
  ため息: '😮‍💨',
  早口: '⏩',
  ゆっくり: '🐢',
  叫び: '😱',
  眠そう: '😪',
  懇願: '🙏',
  ナレーション: '📖',
  間: '⏸️',
});

export function parseDelivery(text) {
  const instructions = [];
  const input = text
    .replace(/\[(感情|演技)[:：]([^\[\]\r\n]*)\]|（([^（）\r\n]*)）/g, (tag, squareKind, squareRaw, roundRaw) => {
      let kind = squareKind;
      let raw = squareRaw;
      if (roundRaw !== undefined) {
        const explicit = /^(感情|演技)[:：](.*)$/.exec(roundRaw.trim());
        if (explicit) {
          [, kind, raw] = explicit;
        } else {
          raw = roundRaw.trim();
          // Only known shorthand is special; ordinary parenthetical dialogue stays spoken.
          if (!Object.hasOwn(DELIVERY_EMOJI, raw)) return tag;
          kind = '感情';
        }
      }
      const value = raw.trim();
      if (!value || [...value].length > 100) throw new Error('感情・演技指示は1～100文字で指定してください');
      if (Object.hasOwn(DELIVERY_EMOJI, value)) return DELIVERY_EMOJI[value];
      // Arbitrary descriptions affect the whole utterance's caption. They do not
      // split speech or replace the character's base identity / seed.
      instructions.push(`${kind}: ${value}`);
      return '';
    })
    .trim();
  if (/(?:\[|（)\s*(?:感情|演技)[:：]/.test(input)) throw new Error('感情・演技指示の閉じカッコを確認してください');
  if (!input) throw new Error('読み上げる本文がありません');
  const caption = instructions.join('。');
  if ([...caption].length > 200) throw new Error('発言の演技指示は合計200文字以下にしてください');
  return { input, caption };
}
