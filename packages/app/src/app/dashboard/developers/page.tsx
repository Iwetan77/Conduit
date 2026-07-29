"use client";

import { useEffect, useState } from "react";
import {
  listApiKeys, listWebhookEndpoints, createWebhookEndpoint, listWebhookDeliveries,
  replayWebhookDelivery, type ApiKeySummary, type WebhookEndpoint, type WebhookDelivery,
  ConduitApiError,
} from "@/lib/conduit-api";
import { formatDate } from "@/lib/format";

export default function DevelopersPage() {
  const [keys, setKeys] = useState<ApiKeySummary[] | null>(null);
  const [endpoints, setEndpoints] = useState<WebhookEndpoint[] | null>(null);
  const [newEndpointURL, setNewEndpointURL] = useState("");
  const [newSecret, setNewSecret] = useState("");
  const [selectedEndpoint, setSelectedEndpoint] = useState<string | null>(null);
  const [deliveries, setDeliveries] = useState<WebhookDelivery[] | null>(null);
  const [error, setError] = useState("");

  const refresh = () => {
    listApiKeys().then((r) => setKeys(r.data ?? [])).catch(() => {});
    listWebhookEndpoints().then((r) => setEndpoints(r.data ?? [])).catch(() => {});
  };

  useEffect(refresh, []);

  const handleCreateEndpoint = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    try {
      const ep = await createWebhookEndpoint({
        url: newEndpointURL,
        enabled_events: ["settlement_intent.created", "settlement_intent.quoted", "settlement.succeeded", "settlement.failed", "settlement_intent.expired"],
      });
      setNewSecret(ep.secret ?? "");
      setNewEndpointURL("");
      refresh();
    } catch (err) {
      setError(err instanceof ConduitApiError ? err.message : "Failed to create endpoint");
    }
  };

  const openDeliveries = (endpointId: string) => {
    setSelectedEndpoint(endpointId);
    listWebhookDeliveries(endpointId).then((r) => setDeliveries(r.data ?? [])).catch(() => setDeliveries([]));
  };

  const handleReplay = async (deliveryId: string) => {
    await replayWebhookDelivery(deliveryId).catch(() => {});
    if (selectedEndpoint) openDeliveries(selectedEndpoint);
  };

  return (
    <div className="space-y-10 max-w-3xl">
      <h1 className="font-display text-3xl font-bold">Developers</h1>

      <section>
        <h2 className="font-medium text-sm mb-3">API keys</h2>
        <div className="border border-brand-border rounded-lg divide-y divide-brand-border">
          {keys === null && <p className="p-4 text-brand-muted text-sm">Loading...</p>}
          {keys?.length === 0 && <p className="p-4 text-brand-muted text-sm">No keys yet.</p>}
          {keys?.map((k) => (
            <div key={k.id} className="p-3 flex items-center justify-between text-sm">
              <span className="font-mono">{k.prefix}••••{k.suffix}</span>
              <span className="text-brand-muted text-xs">{k.type} · {k.livemode ? "live" : "test"}{k.revoked_at ? " · revoked" : ""}</span>
            </div>
          ))}
        </div>
        <p className="text-xs text-brand-muted mt-2">
          Full key values are shown once at creation only (in the onboarding step or account creation response) — never again.
        </p>
      </section>

      <section>
        <h2 className="font-medium text-sm mb-3">Webhook endpoints</h2>
        <form onSubmit={handleCreateEndpoint} className="flex gap-2 mb-3">
          <input
            className="flex-1 bg-brand-surface border border-brand-border rounded px-3 py-2 text-sm"
            placeholder="https://your-server.com/webhooks/conduit"
            value={newEndpointURL}
            onChange={(e) => setNewEndpointURL(e.target.value)}
            required
          />
          <button type="submit" className="bg-brand-green text-brand-black rounded px-4 py-2 text-sm font-medium">Add</button>
        </form>
        {newSecret && (
          <div className="border border-brand-green/40 rounded p-3 mb-3 text-xs">
            Endpoint secret (shown once, save it now): <span className="font-mono">{newSecret}</span>
          </div>
        )}
        {error && <p className="text-red-400 text-sm mb-3">{error}</p>}

        <div className="border border-brand-border rounded-lg divide-y divide-brand-border">
          {endpoints === null && <p className="p-4 text-brand-muted text-sm">Loading...</p>}
          {endpoints?.length === 0 && <p className="p-4 text-brand-muted text-sm">No webhook endpoints yet.</p>}
          {endpoints?.map((ep) => (
            <div key={ep.id} className="p-3 flex items-center justify-between text-sm">
              <span className="font-mono text-xs">{ep.url}</span>
              <button
                onClick={() => openDeliveries(ep.id)}
                className="text-brand-green text-xs hover:underline"
              >
                View deliveries
              </button>
            </div>
          ))}
        </div>
      </section>

      {selectedEndpoint && (
        <section>
          <h2 className="font-medium text-sm mb-3">Delivery log</h2>
          <div className="border border-brand-border rounded-lg overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-brand-border text-brand-muted text-xs uppercase text-left">
                  <th className="px-3 py-2 font-medium">Event</th>
                  <th className="px-3 py-2 font-medium">Attempt</th>
                  <th className="px-3 py-2 font-medium">Response</th>
                  <th className="px-3 py-2 font-medium">Delivered</th>
                  <th className="px-3 py-2 font-medium"></th>
                </tr>
              </thead>
              <tbody>
                {(deliveries ?? []).map((d) => (
                  <tr key={d.id} className="border-b border-brand-border last:border-0">
                    <td className="px-3 py-2">{d.event_type}</td>
                    <td className="px-3 py-2">{d.attempt}</td>
                    <td className="px-3 py-2">{d.response_code ?? "—"}</td>
                    <td className="px-3 py-2">{d.delivered_at ? formatDate(new Date(d.delivered_at).getTime() / 1000) : "pending"}</td>
                    <td className="px-3 py-2">
                      <button onClick={() => handleReplay(d.id)} className="text-brand-green text-xs hover:underline">
                        Replay
                      </button>
                    </td>
                  </tr>
                ))}
                {deliveries?.length === 0 && (
                  <tr><td colSpan={5} className="px-3 py-4 text-center text-brand-muted text-sm">No deliveries yet.</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </div>
  );
}
