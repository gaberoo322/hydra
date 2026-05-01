import { useApi } from "./useApi.js";

export function useAlertCount() {
  const { data } = useApi("/alerts?limit=50", { poll: 10000 });
  return (data || []).filter(a => !a.dismissed).length;
}
