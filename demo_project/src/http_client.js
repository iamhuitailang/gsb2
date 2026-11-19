// Demo HTTP client. All values are synthetic.
const DEMO_BEARER = "Bearer demo-token-7f3c9a1b2d4e6f8091a3b5c7d9e1f3a5";

export async function callDemoApi() {
  return fetch("https://api.example.invalid/v1/ping", {
    headers: { Authorization: DEMO_BEARER },
  });
}
