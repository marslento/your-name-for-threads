import type { ContactsRepository } from "../../storage/ContactsRepository";
import type { DirectoryRepository } from "../../storage/DirectoryRepository";
import type { DashboardStore } from "./DashboardStore";

export interface DashboardServices {
  /** No confirmed owner means no private Directory access - App.tsx never constructs/renders these routes without one. */
  ownerThreadsUserId: string;
  store: DashboardStore;
  repository: ContactsRepository;
  directoryRepository: DirectoryRepository;
}
