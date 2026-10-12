import { Fragment } from 'react';
import type { LucideIcon } from 'lucide-react';
import { useI18n } from '../../i18n';
import type { Tool } from './editorTools';

export interface ToolItem {
    id: Tool;
    icon: LucideIcon;
    label: string;
    /** Shorter caption for the phone tool bar, where labels sit under the icons. */
    shortLabel?: string;
}

interface ToolRailProps {
    /** Related tools, separated by a rule. */
    groups: ToolItem[][];
    activeTool: Tool;
    onToolSelect: (tool: Tool) => void;
}

/** The editor's tools: a column on the left, or a scrolling bar at the bottom on phones. */
export const ToolRail = ({ groups, activeTool, onToolSelect }: ToolRailProps) => {
    const { t } = useI18n();
    return (
        <nav aria-label={t('modal.tools')} className="editor-rail">
            {groups.filter(group => group.length > 0).map((group, index) => (
                <Fragment key={group[0].id}>
                    {index > 0 ? <span className="editor-rail-separator" aria-hidden="true" /> : null}
                    {group.map(tool => (
                        <button
                            key={tool.id}
                            type="button"
                            onClick={() => onToolSelect(tool.id)}
                            className="editor-tool"
                            title={tool.label}
                            aria-label={tool.label}
                            aria-pressed={activeTool === tool.id}
                        >
                            <tool.icon aria-hidden="true" className="h-[1.125rem] w-[1.125rem]" />
                            <span className="editor-tool-label" aria-hidden="true">{tool.shortLabel ?? tool.label}</span>
                        </button>
                    ))}
                </Fragment>
            ))}
        </nav>
    );
};
