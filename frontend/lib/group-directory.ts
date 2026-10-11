import type { Group } from "@/types/academic";

export function filterGroups(
  groups: Group[],
  query: string,
  studyYear: string,
  ownGroupId?: number | null,
): Group[] {
  const needle = query.normalize("NFKC").trim().toLocaleLowerCase("ru");
  return groups
    .filter((group) => {
      const matchesName =
        `${group.name} ${group.program || ""} ${group.curator}`
          .normalize("NFKC")
          .toLocaleLowerCase("ru")
          .includes(needle);
      const matchesYear =
        studyYear === "all" ||
        (studyYear === "unknown"
          ? group.study_year == null
          : group.study_year === Number(studyYear));
      return matchesName && matchesYear;
    })
    .sort(
      (a, b) =>
        Number(b.id === ownGroupId) - Number(a.id === ownGroupId) ||
        a.name.localeCompare(b.name, "ru", { numeric: true }),
    );
}
