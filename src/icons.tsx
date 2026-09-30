import { React } from './runtime'

/**
 * Inline SVG icons for the canvas chrome, in the lucide stroke style (ISC).
 * Each is a *component* (not a module-level element): the classic JSX
 * transform binds `React` inside `register()`, so evaluating JSX at module top
 * level would run with `React === undefined` and reject the bundle. Locked by
 * `bundleLoads.test`. Size and stroke come from CSS (`--canvas-icon-size`,
 * `--canvas-icon-stroke`) so each surface sets its own.
 */
type Icon = () => ReturnType<typeof React.createElement>

const svg = (children: ReturnType<typeof React.createElement>): ReturnType<typeof React.createElement> => (
  <svg
    className="canvas-icon"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    {children}
  </svg>
)

const FILE_OUTLINE = 'M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z'
const FILE_FOLD = 'M14 2v4a2 2 0 0 0 2 2h4'

export const StickyNoteIcon: Icon = () => svg(<><path d="M15.5 3H5a2 2 0 0 0-2 2v14c0 1.1.9 2 2 2h14a2 2 0 0 0 2-2V8.5L15.5 3Z" /><path d="M15 3v6h6" /></>)
export const FileTextIcon: Icon = () => svg(<><path d={FILE_OUTLINE} /><path d={FILE_FOLD} /><path d="M10 9H8" /><path d="M16 13H8" /><path d="M16 17H8" /></>)
export const FileImageIcon: Icon = () => svg(<><path d={FILE_OUTLINE} /><path d={FILE_FOLD} /><circle cx="10" cy="12" r="2" /><path d="m20 17-1.296-1.296a2.41 2.41 0 0 0-3.408 0L9 22" /></>)
export const FileCardIcon: Icon = () => svg(<><path d={FILE_OUTLINE} /><path d={FILE_FOLD} /></>)
export const LinkCardIcon: Icon = () => svg(<><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" /><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" /></>)
export const GlobeIcon: Icon = () => svg(<><circle cx="12" cy="12" r="10" /><path d="M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20" /><path d="M2 12h20" /></>)
export const TextAlignIcon: Icon = () => svg(<><path d="M21 6H3" /><path d="M15 12H3" /><path d="M17 18H3" /></>)
export const GroupIcon: Icon = () => svg(<><rect x="3" y="7" width="18" height="14" rx="2" /><path d="M3 9V5a2 2 0 0 1 2-2h6v4" /></>)

export const SettingsIcon: Icon = () => svg(<><path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" /><circle cx="12" cy="12" r="3" /></>)
export const LockIcon: Icon = () => svg(<><rect width="18" height="11" x="3" y="11" rx="2" ry="2" /><path d="M7 11V7a5 5 0 0 1 10 0v4" /></>)
export const PlusIcon: Icon = () => svg(<><path d="M5 12h14" /><path d="M12 5v14" /></>)
export const MinusIcon: Icon = () => svg(<path d="M5 12h14" />)
export const RotateCwIcon: Icon = () => svg(<><path d="M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8" /><path d="M21 3v5h-5" /></>)
export const MaximizeIcon: Icon = () => svg(<><path d="M8 3H5a2 2 0 0 0-2 2v3" /><path d="M21 8V5a2 2 0 0 0-2-2h-3" /><path d="M3 16v3a2 2 0 0 0 2 2h3" /><path d="M16 21h3a2 2 0 0 0 2-2v-3" /></>)
export const UndoIcon: Icon = () => svg(<><path d="M9 14 4 9l5-5" /><path d="M4 9h10.5a5.5 5.5 0 0 1 5.5 5.5a5.5 5.5 0 0 1-5.5 5.5H11" /></>)
export const RedoIcon: Icon = () => svg(<><path d="m15 14 5-5-5-5" /><path d="M20 9H9.5A5.5 5.5 0 0 0 4 14.5A5.5 5.5 0 0 0 9.5 20H13" /></>)
export const HelpIcon: Icon = () => svg(<><circle cx="12" cy="12" r="10" /><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3" /><path d="M12 17h.01" /></>)

export const TrashIcon: Icon = () => svg(<><path d="M3 6h18" /><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6" /><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2" /><path d="M10 11v6" /><path d="M14 11v6" /></>)
export const PaletteIcon: Icon = () => svg(<><circle cx="13.5" cy="6.5" r=".5" fill="currentColor" /><circle cx="17.5" cy="10.5" r=".5" fill="currentColor" /><circle cx="8.5" cy="7.5" r=".5" fill="currentColor" /><circle cx="6.5" cy="12.5" r=".5" fill="currentColor" /><path d="M12 2C6.5 2 2 6.5 2 12s4.5 10 10 10c.926 0 1.648-.746 1.648-1.688 0-.437-.18-.835-.437-1.125-.29-.289-.438-.652-.438-1.125a1.64 1.64 0 0 1 1.668-1.668h1.996c3.051 0 5.555-2.503 5.555-5.554C21.965 6.012 17.461 2 12 2z" /></>)
export const ZoomToSelectionIcon: Icon = () => svg(<><path d="M8 3H5a2 2 0 0 0-2 2v3" /><path d="M21 8V5a2 2 0 0 0-2-2h-3" /><path d="M3 16v3a2 2 0 0 0 2 2h3" /><path d="M16 21h3a2 2 0 0 0 2-2v-3" /><rect x="8" y="8" width="8" height="8" rx="1" /></>)
export const EditIcon: Icon = () => svg(<><path d="M12 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" /><path d="M18.375 2.625a1 1 0 0 1 3 3l-9.013 9.014a2 2 0 0 1-.853.505l-2.873.84a.5.5 0 0 1-.62-.62l.84-2.873a2 2 0 0 1 .506-.852z" /></>)
export const ImageIcon: Icon = () => svg(<><rect width="18" height="18" x="3" y="3" rx="2" ry="2" /><circle cx="9" cy="9" r="2" /><path d="m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21" /></>)
export const ImageOffIcon: Icon = () => svg(<><path d="m2 2 20 20" /><path d="M10.41 10.41a2 2 0 1 1-2.83-2.83" /><path d="M13.5 13.5 6 21" /><path d="M18 12l3 3" /><path d="M3.59 3.59A1.99 1.99 0 0 0 3 5v14a2 2 0 0 0 2 2h14c.55 0 1.052-.22 1.41-.59" /><path d="M21 15V5a2 2 0 0 0-2-2H9" /></>)
export const RepeatIcon: Icon = () => svg(<><path d="m17 2 4 4-4 4" /><path d="M3 11v-1a4 4 0 0 1 4-4h14" /><path d="m7 22-4-4 4-4" /><path d="M21 13v1a4 4 0 0 1-4 4H3" /></>)
export const ScalingIcon: Icon = () => svg(<><path d="M21 3 9 15" /><path d="M12 3H3v18h18v-9" /><path d="M16 3h5v5" /><path d="M14 15H9v-5" /></>)
export const AspectRatioIcon: Icon = () => svg(<><rect width="20" height="16" x="2" y="4" rx="2" /><path d="M12 9v11" /><path d="M2 9h13a2 2 0 0 1 2 2v9" /></>)
export const LayoutGridIcon: Icon = () => svg(<><rect width="7" height="7" x="3" y="3" rx="1" /><rect width="7" height="7" x="14" y="3" rx="1" /><rect width="7" height="7" x="14" y="14" rx="1" /><rect width="7" height="7" x="3" y="14" rx="1" /></>)
export const RemoveLabelIcon: Icon = () => svg(<><rect width="18" height="18" x="3" y="3" rx="2" /><path d="m15 9-6 6" /><path d="m9 9 6 6" /></>)
export const DuplicateIcon: Icon = () => svg(<><rect width="14" height="14" x="8" y="8" rx="2" ry="2" /><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2" /></>)
export const MoreIcon: Icon = () => svg(<><circle cx="12" cy="12" r="1" /><circle cx="19" cy="12" r="1" /><circle cx="5" cy="12" r="1" /></>)
export const BringToFrontIcon: Icon = () => svg(<><rect x="8" y="8" width="8" height="8" rx="2" /><path d="M4 10a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2" /><path d="M14 20a2 2 0 0 0 2 2h4a2 2 0 0 0 2-2v-4a2 2 0 0 0-2-2" /></>)
export const SendToBackIcon: Icon = () => svg(<><rect x="14" y="14" width="8" height="8" rx="2" /><rect x="2" y="2" width="8" height="8" rx="2" /><path d="M7 14v1a2 2 0 0 0 2 2h1" /><path d="M14 7h1a2 2 0 0 1 2 2v1" /></>)
export const OpenIcon: Icon = () => svg(<><path d="M15 3h6v6" /><path d="M10 14 21 3" /><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" /></>)
export const FileInputIcon: Icon = () => svg(<><path d="M4 22h14a2 2 0 0 0 2-2V7l-5-5H6a2 2 0 0 0-2 2v4" /><path d="M14 2v4a2 2 0 0 0 2 2h4" /><path d="M2 15h10" /><path d="m9 18 3-3-3-3" /></>)
export const ClipboardIcon: Icon = () => svg(<><rect width="8" height="4" x="8" y="2" rx="1" ry="1" /><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2" /></>)
export const TableIcon: Icon = () => svg(<><path d="M12 3v18" /><rect width="18" height="18" x="3" y="3" rx="2" /><path d="M3 9h18" /><path d="M3 15h18" /></>)

/** Line-direction glyphs: the one shown is the edge's current direction. */
export const ArrowRightIcon: Icon = () => svg(<><path d="M5 12h14" /><path d="m12 5 7 7-7 7" /></>)
export const MoveHorizontalIcon: Icon = () => svg(<><path d="m18 8 4 4-4 4" /><path d="M2 12h20" /><path d="m6 8-4 4 4 4" /></>)
export const LineHorizontalIcon: Icon = () => svg(<path d="M3 12h18" />)

export const AlignStartVerticalIcon: Icon = () => svg(<><rect width="9" height="6" x="6" y="14" rx="2" /><rect width="16" height="6" x="6" y="4" rx="2" /><path d="M2 2v20" /></>)
export const AlignCenterVerticalIcon: Icon = () => svg(<><path d="M12 2v20" /><path d="M8 10H4a2 2 0 0 1-2-2V6c0-1.1.9-2 2-2h4" /><path d="M16 10h4a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2h-4" /><path d="M8 20H7a2 2 0 0 1-2-2v-2c0-1.1.9-2 2-2h1" /><path d="M16 14h1a2 2 0 0 1 2 2v2a2 2 0 0 1-2 2h-1" /></>)
export const AlignEndVerticalIcon: Icon = () => svg(<><rect width="16" height="6" x="2" y="4" rx="2" /><rect width="9" height="6" x="9" y="14" rx="2" /><path d="M22 22V2" /></>)
export const AlignStartHorizontalIcon: Icon = () => svg(<><rect width="6" height="16" x="4" y="6" rx="2" /><rect width="6" height="9" x="14" y="6" rx="2" /><path d="M22 2H2" /></>)
export const AlignCenterHorizontalIcon: Icon = () => svg(<><path d="M2 12h20" /><path d="M10 16v4a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2v-4" /><path d="M10 8V4a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v4" /><path d="M20 16v1a2 2 0 0 1-2 2h-2a2 2 0 0 1-2-2v-1" /><path d="M14 8V7c0-1.1.9-2 2-2h2a2 2 0 0 1 2 2v1" /></>)
export const AlignEndHorizontalIcon: Icon = () => svg(<><rect width="6" height="16" x="4" y="2" rx="2" /><rect width="6" height="9" x="14" y="9" rx="2" /><path d="M22 22H2" /></>)
export const StackHorizontalIcon: Icon = () => svg(<><rect width="6" height="14" x="3" y="5" rx="1" /><rect width="6" height="14" x="15" y="5" rx="1" /></>)
export const StackVerticalIcon: Icon = () => svg(<><rect width="14" height="6" x="5" y="3" rx="1" /><rect width="14" height="6" x="5" y="15" rx="1" /></>)
export const DistributeHorizontalIcon: Icon = () => svg(<><rect width="6" height="14" x="9" y="5" rx="1" /><path d="M3 3v18" /><path d="M21 3v18" /></>)
export const DistributeVerticalIcon: Icon = () => svg(<><rect width="14" height="6" x="5" y="9" rx="1" /><path d="M3 3h18" /><path d="M3 21h18" /></>)
export const StretchHorizontalIcon: Icon = () => svg(<><rect width="20" height="6" x="2" y="4" rx="2" /><rect width="20" height="6" x="2" y="14" rx="2" /></>)
export const StretchVerticalIcon: Icon = () => svg(<><rect width="6" height="20" x="4" y="2" rx="2" /><rect width="6" height="20" x="14" y="2" rx="2" /></>)
