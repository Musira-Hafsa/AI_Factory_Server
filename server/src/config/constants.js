// Shared domain constants. Kept in one place so validation, the AI service,
// and the seed script can never drift apart.

export const ROLES = ['customer', 'agent', 'admin'];

export const CATEGORIES = [
  'Billing',
  'Technical',
  'Account',
  'Shipping',
  'Product',
  'General',
];

export const PRIORITIES = ['Low', 'Medium', 'High'];

export const STATUSES = ['New', 'Assigned', 'In Progress', 'Resolved'];

// Allowed forward transitions in the normal workflow. A resolved ticket has no
// entry here — it can only leave "Resolved" via an explicit reopen.
export const STATUS_TRANSITIONS = {
  New: ['Assigned', 'In Progress'],
  Assigned: ['In Progress', 'New'],
  'In Progress': ['Resolved', 'Assigned'],
  Resolved: [],
};
