import largePlugin from "./large.js";
export default async function largeParentPlugin(server: any) {
  server.register(largePlugin, { prefix: "/nested" });
}
