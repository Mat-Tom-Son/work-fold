import type { CSSProperties } from "react";
import {
  AddCircle16Regular, AddCircle20Regular,
  Archive16Regular, Archive20Regular,
  ArrowClockwise16Regular, ArrowClockwise20Regular,
  ArrowCounterclockwise16Regular, ArrowCounterclockwise20Regular,
  ArrowDown16Regular, ArrowDown20Regular,
  ArrowDownload16Regular, ArrowDownload20Regular,
  ArrowLeft16Regular, ArrowLeft20Regular,
  ArrowRight16Regular, ArrowRight20Regular,
  ArrowSort16Regular, ArrowSort20Regular,
  ArrowUndo16Regular, ArrowUndo20Regular,
  ArrowUp16Regular, ArrowUp20Regular,
  ArrowUpload16Regular, ArrowUpload20Regular,
  Braces16Regular, Braces20Regular,
  Checkmark16Regular, Checkmark20Regular,
  CheckmarkCircle16Regular, CheckmarkCircle20Regular,
  ChevronDown16Regular, ChevronDown20Regular,
  ChevronLeft16Regular, ChevronLeft20Regular,
  ChevronRight16Regular, ChevronRight20Regular,
  Circle16Regular, Circle20Regular,
  Clock16Regular, Clock20Regular,
  Compose16Regular, Compose20Regular,
  Copy16Regular, Copy20Regular,
  CursorClick20Regular,
  Delete16Regular, Delete20Regular,
  Dismiss16Regular, Dismiss20Regular,
  Document16Regular, Document20Regular,
  DocumentAdd16Regular, DocumentAdd20Regular,
  DocumentCheckmark16Regular, DocumentCheckmark20Regular,
  Edit16Regular, Edit20Regular,
  ErrorCircle16Regular, ErrorCircle20Regular,
  Folder16Regular, Folder20Regular,
  FolderAdd16Regular, FolderAdd20Regular,
  FolderOpen16Regular, FolderOpen20Regular,
  Globe16Regular, Globe20Regular,
  History16Regular, History20Regular,
  Key16Regular, Key20Regular,
  Link16Regular, Link20Regular,
  MoreHorizontal16Regular, MoreHorizontal20Regular,
  Open16Regular, Open20Regular,
  Search16Regular, Search20Regular,
  ShareIos20Regular,
  SpinnerIos16Regular, SpinnerIos20Regular,
  Square16Regular, Square20Regular,
  Warning16Regular, Warning20Regular,
  Window16Regular, Window20Regular,
  type FluentIcon,
} from "@fluentui/react-icons";

/**
 * Interface icons are drawn from Fluent, the family the rail, menus, and
 * Settings already use (docs/visual-design.md). The three requested Lucide
 * exceptions (the rail's Blocks, Settings' Layout Panel Left and Globe Code)
 * stay with their controls and are deliberately not offered here. These components keep the names and `size` prop the
 * call sites were written with, so a call site reads the same while its
 * drawing matches the rest of the app. A size of 16 or less uses Fluent's
 * 16px drawing, which has the right stroke weight at small sizes.
 */
export interface IconProps {
  size?: number;
  className?: string;
  style?: CSSProperties;
  /** Accepted for old call sites; Fluent drawings have a fixed stroke. */
  strokeWidth?: number;
  title?: string;
  "aria-hidden"?: boolean | "true" | "false";
  "aria-label"?: string;
}

function icon(name: string, small: FluentIcon, large: FluentIcon = small) {
  function Icon({ size = 16, strokeWidth: _strokeWidth, style, ...rest }: IconProps) {
    const Drawing = size <= 16 ? small : large;
    return <Drawing {...rest} style={{ width: size, height: size, flex: "0 0 auto", ...style }} />;
  }
  Icon.displayName = name;
  return Icon;
}

export const AlertCircle = icon("AlertCircle", ErrorCircle16Regular, ErrorCircle20Regular);
export const AlertTriangle = icon("AlertTriangle", Warning16Regular, Warning20Regular);
export const AppWindow = icon("AppWindow", Window16Regular, Window20Regular);
export const Archive = icon("Archive", Archive16Regular, Archive20Regular);
export const ArrowDown = icon("ArrowDown", ArrowDown16Regular, ArrowDown20Regular);
export const ArrowLeft = icon("ArrowLeft", ArrowLeft16Regular, ArrowLeft20Regular);
export const ArrowRight = icon("ArrowRight", ArrowRight16Regular, ArrowRight20Regular);
export const ArrowUp = icon("ArrowUp", ArrowUp16Regular, ArrowUp20Regular);
export const ArrowUpDown = icon("ArrowUpDown", ArrowSort16Regular, ArrowSort20Regular);
export const Braces = icon("Braces", Braces16Regular, Braces20Regular);
export const Check = icon("Check", Checkmark16Regular, Checkmark20Regular);
export const ChevronDown = icon("ChevronDown", ChevronDown16Regular, ChevronDown20Regular);
export const ChevronLeft = icon("ChevronLeft", ChevronLeft16Regular, ChevronLeft20Regular);
export const ChevronRight = icon("ChevronRight", ChevronRight16Regular, ChevronRight20Regular);
export const Circle = icon("Circle", Circle16Regular, Circle20Regular);
export const CircleCheck = icon("CircleCheck", CheckmarkCircle16Regular, CheckmarkCircle20Regular);
export const CirclePlus = icon("CirclePlus", AddCircle16Regular, AddCircle20Regular);
export const Clock3 = icon("Clock3", Clock16Regular, Clock20Regular);
export const Copy = icon("Copy", Copy16Regular, Copy20Regular);
export const Download = icon("Download", ArrowDownload16Regular, ArrowDownload20Regular);
export const ExternalLink = icon("ExternalLink", Open16Regular, Open20Regular);
export const File = icon("File", Document16Regular, Document20Regular);
export const FileCheck2 = icon("FileCheck2", DocumentCheckmark16Regular, DocumentCheckmark20Regular);
export const FilePlus2 = icon("FilePlus2", DocumentAdd16Regular, DocumentAdd20Regular);
export const Folder = icon("Folder", Folder16Regular, Folder20Regular);
export const FolderOpen = icon("FolderOpen", FolderOpen16Regular, FolderOpen20Regular);
export const FolderPlus = icon("FolderPlus", FolderAdd16Regular, FolderAdd20Regular);
export const Globe = icon("Globe", Globe16Regular, Globe20Regular);
export const History = icon("History", History16Regular, History20Regular);
export const KeyRound = icon("KeyRound", Key16Regular, Key20Regular);
export const Link2 = icon("Link2", Link16Regular, Link20Regular);
export const Loader2 = icon("Loader2", SpinnerIos16Regular, SpinnerIos20Regular);
export const MoreHorizontal = icon("MoreHorizontal", MoreHorizontal16Regular, MoreHorizontal20Regular);
export const MousePointerClick = icon("MousePointerClick", CursorClick20Regular);
export const Pencil = icon("Pencil", Edit16Regular, Edit20Regular);
export const PencilLine = icon("PencilLine", Edit16Regular, Edit20Regular);
export const RefreshCw = icon("RefreshCw", ArrowClockwise16Regular, ArrowClockwise20Regular);
export const RotateCcw = icon("RotateCcw", ArrowCounterclockwise16Regular, ArrowCounterclockwise20Regular);
export const Search = icon("Search", Search16Regular, Search20Regular);
/** The Mac share mark (a box with an arrow), for share actions. */
export const Share2 = icon("Share2", ShareIos20Regular);
/** A page shared on the web: the mark beside a shared file. */
export const SharedOnWeb = icon("SharedOnWeb", Globe16Regular, Globe20Regular);
export const Square = icon("Square", Square16Regular, Square20Regular);
export const SquarePen = icon("SquarePen", Compose16Regular, Compose20Regular);
export const Trash2 = icon("Trash2", Delete16Regular, Delete20Regular);
export const Undo2 = icon("Undo2", ArrowUndo16Regular, ArrowUndo20Regular);
export const Upload = icon("Upload", ArrowUpload16Regular, ArrowUpload20Regular);
export const X = icon("X", Dismiss16Regular, Dismiss20Regular);
