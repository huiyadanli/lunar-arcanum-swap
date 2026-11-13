export function statePollDelay({ listing, matches = [], visible = true }) {
  if (!visible) return null;
  if (matches.some(m => ['matched', 'confirming'].includes(m.status))) return 10000;
  if (listing && Object.values(listing.give).some(q => q > 0) && listing.want.length) return 30000;
  return null;
}
