'use strict';

/* ===================================================================
   IRONPEAK GYM — membership plans

   Single source of truth for plan names, prices and billing cycles.
   The public form, the dashboard and the API all validate against
   this list, so a price can never drift between pages.
   =================================================================== */

const PLANS = [
  { name: 'Monthly',   price: 3500,  cycleDays: 30,  label: 'Monthly Rs. 3,500' },
  { name: 'Quarterly', price: 9500,  cycleDays: 90,  label: 'Quarterly Rs. 9,500' },
  { name: 'Annual',    price: 32000, cycleDays: 365, label: 'Annual Rs. 32,000' },
];

const PLANS_BY_NAME = new Map(PLANS.map((plan) => [plan.name, plan]));

/** Look up a plan by name, or undefined when the name is unknown. */
function getPlan(name) {
  return PLANS_BY_NAME.get(name);
}

/** Billing cycle length in days. Falls back to the monthly cycle. */
function planCycleDays(name) {
  return getPlan(name)?.cycleDays ?? 30;
}

/** Sticker price for a plan, or 0 when the name is unknown. */
function planPrice(name) {
  return getPlan(name)?.price ?? 0;
}

/** Days before the due date at which a member counts as "due soon". */
const DUE_SOON_DAYS = 5;

module.exports = { PLANS, getPlan, planCycleDays, planPrice, DUE_SOON_DAYS };
