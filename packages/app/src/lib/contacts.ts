"use client";

// People you have paid, so you never type a hex address twice.
//
// Stored in this browser, keyed by the wallet doing the saving. Deliberately
// not on the server, for now:
//
//   - Half the people using this have no account. A payer with only an EVM
//     wallet has no session, so a server-side contact list would need its own
//     auth, and the wallet-signature path costs a prompt per read.
//   - A contact list is a social graph. Keeping it on the device means we hold
//     no record of who pays whom, which is the right default for a payments
//     product and cannot be leaked from a database that does not have it.
//
// The trade is real and worth naming: contacts do not follow you to another
// device. Contacts saved as a USERNAME survive better than ones saved as an
// address, because the name is re-resolved on every use -- so if someone's
// settlement address ever changes, a name still reaches them and a stored
// address does not.
import { useCallback, useEffect, useState } from "react";

export interface Contact {
  /** The username, when the contact was saved by name. */
  username?: string;
  /** Always present: what a payment to this contact is addressed to today. */
  address: string;
  /** What to call them in the list — their account name, or the username. */
  label: string;
  /** Unix ms. Used to order by most recent, not to expire anything. */
  savedAt: number;
}

const KEY_PREFIX = "conduit.contacts.";
/** Enough to be useful, small enough that the picker never becomes a page. */
const MAX_CONTACTS = 24;

function keyFor(owner: string) {
  return `${KEY_PREFIX}${owner.toLowerCase()}`;
}

export function readContacts(owner?: string): Contact[] {
  if (!owner || typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(keyFor(owner));
    if (!raw) return [];
    const parsed = JSON.parse(raw) as Contact[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function write(owner: string, contacts: Contact[]) {
  try {
    window.localStorage.setItem(keyFor(owner), JSON.stringify(contacts));
  } catch {
    // Private browsing or quota. Losing a contact list is not worth an error
    // in front of someone trying to send money.
  }
}

/**
 * Identity for deduping.
 *
 * A username when there is one, because that is the durable handle: the same
 * person saved once by name and once by address should not appear twice, and
 * the name is the entry worth keeping.
 */
function identity(c: Pick<Contact, "username" | "address">): string {
  return (c.username ?? c.address).toLowerCase();
}

export function saveContact(owner: string, contact: Omit<Contact, "savedAt">): Contact[] {
  const existing = readContacts(owner).filter((c) => identity(c) !== identity(contact));
  // Most recent first, so the picker shows who you actually pay.
  const next = [{ ...contact, savedAt: Date.now() }, ...existing].slice(0, MAX_CONTACTS);
  write(owner, next);
  return next;
}

export function removeContact(owner: string, id: string): Contact[] {
  const next = readContacts(owner).filter((c) => identity(c) !== id.toLowerCase());
  write(owner, next);
  return next;
}

export function contactId(c: Pick<Contact, "username" | "address">): string {
  return identity(c);
}

/**
 * Contacts for the connected wallet, and the writes that update them.
 *
 * Reads after mount rather than during render: localStorage does not exist on
 * the server, and a component that read it while rendering would hydrate
 * differently than it server-rendered.
 */
export function useContacts(owner?: string) {
  const [contacts, setContacts] = useState<Contact[]>([]);

  useEffect(() => {
    setContacts(readContacts(owner));
  }, [owner]);

  const save = useCallback(
    (contact: Omit<Contact, "savedAt">) => {
      if (!owner) return;
      setContacts(saveContact(owner, contact));
    },
    [owner],
  );

  const remove = useCallback(
    (id: string) => {
      if (!owner) return;
      setContacts(removeContact(owner, id));
    },
    [owner],
  );

  const has = useCallback(
    (c: Pick<Contact, "username" | "address">) =>
      contacts.some((existing) => identity(existing) === identity(c)),
    [contacts],
  );

  return { contacts, save, remove, has };
}
