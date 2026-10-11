import type { ProjectBranding } from "./branding";

export type BrandingState = {
  branding: ProjectBranding;
  loading: boolean;
  error: string;
};

export function createBrandingStore(
  initialBranding: ProjectBranding,
  load: () => Promise<ProjectBranding>,
) {
  const initialState: BrandingState = {
    branding: initialBranding,
    loading: true,
    error: "",
  };
  let state = initialState;
  let pending: Promise<void> | null = null;
  let refreshQueued = false;
  let revision = 0;
  const listeners = new Set<() => void>();

  function publish(next: BrandingState) {
    state = next;
    listeners.forEach((listener) => listener());
  }
  function refresh(force = false): Promise<void> {
    if (force) revision += 1;
    if (pending) {
      if (force) refreshQueued = true;
      return pending;
    }
    const requestRevision = revision;
    pending = load()
      .then((branding) => {
        if (revision !== requestRevision) return;
        publish({ branding, loading: false, error: "" });
      })
      .catch((error: unknown) => {
        if (revision !== requestRevision) return;
        publish({
          ...state,
          loading: false,
          error:
            error instanceof Error
              ? error.message
              : "Не удалось загрузить логотип проекта.",
        });
      })
      .finally(() => {
        pending = null;
        if (refreshQueued) {
          refreshQueued = false;
          return refresh();
        }
      });
    return pending;
  }
  return {
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getSnapshot: () => state,
    getServerSnapshot: () => initialState,
    refresh,
    update(branding: ProjectBranding) {
      revision += 1;
      publish({ branding, loading: false, error: "" });
    },
  };
}
