export const config = { runtime: "edge" };
export default async function handler() {
  return new Response(JSON.stringify({ ok: true, msg: "hello" }), {
    headers: { "Content-Type": "application/json" }
  });
}
