const db = require("../db");

// Records that belong to a customer now point at a customer record rather than
// carrying a name somebody typed. The name is still stored on the row — it is
// what the document said at the time — but it is copied from the record, not
// entered by hand, so the same company can no longer exist three times over
// under three spellings.
//
// The practical reason, beyond tidiness: a statement can only be emailed to a
// customer that resolves to a record with an address on it. A typed name that
// matches nothing produces an invoice nobody can send, and that is discovered
// at the moment somebody tries.

async function resolveCustomer(customerId) {
  if (customerId === undefined || customerId === null || customerId === "") {
    return {
      error: "Choose a customer. If they are not listed, add them on the Customers page first.",
    };
  }
  const customer = await db.prepare("SELECT id, name, status FROM customers WHERE id = ?").get(customerId);
  if (!customer) {
    return { error: "That customer no longer exists. Pick another, or add them on the Customers page." };
  }
  // Retired customers stay selectable on records that already point at them —
  // history must not break — but nothing new should be raised against one.
  if (customer.status !== "active") {
    return {
      error: `${customer.name} is marked inactive. Reactivate them on the Customers page before raising anything new.`,
    };
  }
  return { customer };
}

// For edits, where the record already has a customer and the caller may not be
// changing it. Leaves it alone when nothing was sent.
async function resolveCustomerForUpdate(body, existing) {
  if (body.customer_id === undefined) {
    return { customer: null, customerId: existing.customer_id, customerName: existing.customer_name };
  }
  const { error, customer } = await resolveCustomer(body.customer_id);
  if (error) return { error };
  return { customer, customerId: customer.id, customerName: customer.name };
}

module.exports = { resolveCustomer, resolveCustomerForUpdate };
