export const config = { runtime: "edge" };
export default async function handler() {
  return new Response(JSON.stringify({ ok: true, route: "/api/genesys" }), {
    headers: { "Content-Type": "application/json" }
  });
}
