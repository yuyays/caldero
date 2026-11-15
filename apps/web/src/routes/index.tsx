import { createFileRoute } from "@tanstack/react-router";
import { Inbox } from "@/components/inbox.js";

export const Route = createFileRoute("/")({ component: Inbox });
