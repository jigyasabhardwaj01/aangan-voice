import { env, missingConfig } from "@/lib/env";
import { recordIntegration } from "@/domain/audit";
import { httpJson, ProviderError } from "./http";

const BASE = "https://api.hubapi.com";
const h = () => ({ Authorization: `Bearer ${env.get("HUBSPOT_ACCESS_TOKEN")}`, "Content-Type": "application/json" });

function requireConfig() {
  const missing = missingConfig("hubspot");
  if (missing.length) throw new ProviderError("not_configured", `HubSpot not configured: missing ${missing.join(", ")}`);
}

/** Find a contact by phone (to avoid duplicates) or create one. Returns the contact id. */
export async function upsertContact(input: { phone: string | null; email: string | null; name: string | null }): Promise<string> {
  requireConfig();
  try {
    if (input.phone) {
      const { body } = await httpJson(`${BASE}/crm/v3/objects/contacts/search`, {
        method: "POST",
        headers: h(),
        body: JSON.stringify({ filterGroups: [{ filters: [{ propertyName: "phone", operator: "EQ", value: input.phone }] }], limit: 1 }),
      });
      const found = (body as { results?: { id: string }[] })?.results?.[0];
      if (found) return found.id;
    }
    const [first, ...rest] = (input.name ?? "").split(" ");
    const { body } = await httpJson(`${BASE}/crm/v3/objects/contacts`, {
      method: "POST",
      headers: h(),
      body: JSON.stringify({
        properties: {
          ...(input.phone ? { phone: input.phone } : {}),
          ...(input.email ? { email: input.email } : {}),
          ...(first ? { firstname: first } : {}),
          ...(rest.length ? { lastname: rest.join(" ") } : {}),
        },
      }),
    });
    const id = (body as { id?: string })?.id;
    if (!id) throw new ProviderError("invalid_response", "contact create returned no id");
    await recordIntegration("hubspot", true, "upsert_contact");
    return id;
  } catch (e) {
    await recordIntegration("hubspot", false, "upsert_contact", e instanceof Error ? e.message : String(e));
    throw e;
  }
}

export async function createDeal(input: { contactId: string; name: string; description: string }): Promise<string> {
  requireConfig();
  try {
    const { body } = await httpJson(`${BASE}/crm/v3/objects/deals`, {
      method: "POST",
      headers: h(),
      body: JSON.stringify({
        properties: {
          dealname: input.name,
          pipeline: env.get("HUBSPOT_PIPELINE_ID"),
          dealstage: env.get("HUBSPOT_DEAL_STAGE_ID"),
          description: input.description.slice(0, 60_000),
        },
        // 3 = HubSpot-defined deal→contact association
        associations: [{ to: { id: input.contactId }, types: [{ associationCategory: "HUBSPOT_DEFINED", associationTypeId: 3 }] }],
      }),
    });
    const id = (body as { id?: string })?.id;
    if (!id) throw new ProviderError("invalid_response", "deal create returned no id");
    await recordIntegration("hubspot", true, "create_deal");
    return id;
  } catch (e) {
    await recordIntegration("hubspot", false, "create_deal", e instanceof Error ? e.message : String(e));
    throw e;
  }
}
