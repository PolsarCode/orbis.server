export const TWO_FACTOR_PURPOSE = 'two-factor';
export const TICKET_LIFETIME = '5m';

export function ticketSecret() {
  return `${process.env.JWT_SECRET}:${TWO_FACTOR_PURPOSE}`;
}
