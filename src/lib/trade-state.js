const ACTIVE = ['matched', 'confirming'];

export function hasWaitingCards(listing) {
  return !!listing && Object.values(listing.give).some(quantity => quantity > 0) && listing.want.length > 0;
}

export function canStartTrade(match) {
  return ACTIVE.includes(match.status) && !match.partner.uid && !match.myConfirm;
}

export function matchStatus(match) {
  if (match.status === 'confirming' && !match.myConfirm) return 'awaitingConfirmation';
  if (match.status === 'matched') return match.revealed ? 'trading' : 'matched';
  return match.status;
}
