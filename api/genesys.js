export const config = { runtime: "edge" };
export default async function handler() {
  return new Response(JSON.stringify({ ok: true, endpoints: ["save","get","list","delete","roll"] }), {
    headers: { "Content-Type": "application/json" }
  });
}
