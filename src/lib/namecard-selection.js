/** 名片展示完整选牌意愿；正在交换的牌仍计入，与撮合时的可用牌分开计算。 */
export function getNamecardSelection({ mode, quick, counts, keep, wantOff }) {
  if (mode === 'quick') return { give: { ...quick.give }, want: [...quick.want] };
  const give = {};
  const want = [];
  counts.forEach((count, index) => {
    const id = index + 1;
    const spare = Math.max(0, count - keep);
    if (spare > 0) give[id] = spare;
    if (count === 0 && !wantOff.includes(id)) want.push(id);
  });
  return { give, want };
}

export function hasNamecardSelection(request) {
  return !!request && Object.values(request.give).some((quantity) => quantity > 0) && request.want.length > 0;
}
