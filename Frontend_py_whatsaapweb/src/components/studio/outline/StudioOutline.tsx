import React, { useState, useEffect, useCallback, useMemo } from 'react';
import type { StudioOutlineProps, OutlineTreeItem } from '../types';
import { buildTreeFromDag } from './dagToTree';
import {
  ChevronRight,
  ChevronDown,
  Webhook,
  GitBranch,
  Clock,
  Globe,
  UserCheck,
  CheckCircle2,
  AlertTriangle,
  Folder,
} from 'lucide-react';

export const StudioOutline: React.FC<StudioOutlineProps> = ({
  dagGraph,
  selectedNodeId,
  onSelectNode,
  activeRun,
  validationErrors,
  className = '',
}) => {
  // Expanded item IDs (defaults to expanding all root parents)
  const [expandedIds, setExpandedIds] = useState<Set<string>>(() => {
    const initial = new Set<string>();
    dagGraph.nodes.forEach((n) => initial.add(`tree-item-${n.id}`));
    initial.add('tree-item-group-orphans');
    return initial;
  });

  // Roving tabindex focused node ID
  const [focusedId, setFocusedId] = useState<string>(() => {
    return selectedNodeId || dagGraph.nodes[0]?.id || '';
  });

  // Polite live announcement message
  const [announcement, setAnnouncement] = useState<string>('');

  // Keep focusedId in sync when selectedNodeId changes externally
  useEffect(() => {
    if (selectedNodeId) {
      setFocusedId(selectedNodeId);
      // Auto-expand all parents of selectedNodeId
      setExpandedIds((prev) => {
        const next = new Set(prev);
        // Ensure all ancestor items are expanded
        dagGraph.nodes.forEach((n) => next.add(`tree-item-${n.id}`));
        return next;
      });
      const node = dagGraph.nodes.find((n) => n.id === selectedNodeId);
      if (node) {
        setAnnouncement(`Nodo seleccionado: ${node.label || node.id}`);
      }
    }
  }, [selectedNodeId, dagGraph.nodes]);

  // Build the hierarchical tree
  const tree = useMemo(() => {
    return buildTreeFromDag(
      dagGraph.nodes,
      dagGraph.edges,
      selectedNodeId,
      expandedIds,
      activeRun?.currentStep
    );
  }, [dagGraph.nodes, dagGraph.edges, selectedNodeId, expandedIds, activeRun?.currentStep]);

  // Flattened visible items list for keyboard navigation
  const visibleItems = useMemo(() => {
    const list: { item: OutlineTreeItem; parent?: OutlineTreeItem }[] = [];

    function collect(items: readonly OutlineTreeItem[], parent?: OutlineTreeItem) {
      for (const item of items) {
        list.push({ item, parent });
        if (item.hasChildren && item.isExpanded) {
          collect(item.children, item);
        }
      }
    }

    collect(tree);
    return list;
  }, [tree]);

  const toggleExpand = useCallback((treeItemId: string) => {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(treeItemId)) {
        next.delete(treeItemId);
      } else {
        next.add(treeItemId);
      }
      return next;
    });
  }, []);

  const handleSelect = useCallback(
    (nodeId: string, label: string) => {
      if (nodeId === '__orphans__') return;
      setFocusedId(nodeId);
      onSelectNode(nodeId);
      setAnnouncement(`Seleccionado ${label}`);
    },
    [onSelectNode]
  );

  // Keyboard navigation handler for WAI-ARIA Treeview 1.2
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent, currentItem: OutlineTreeItem, parentItem?: OutlineTreeItem) => {
      const currentIndex = visibleItems.findIndex((v) => v.item.nodeId === currentItem.nodeId);
      if (currentIndex === -1) return;

      switch (e.key) {
        case 'ArrowDown': {
          e.preventDefault();
          if (currentIndex < visibleItems.length - 1) {
            const nextItem = visibleItems[currentIndex + 1].item;
            setFocusedId(nextItem.nodeId);
            const domEl = document.getElementById(nextItem.id);
            domEl?.focus();
          }
          break;
        }

        case 'ArrowUp': {
          e.preventDefault();
          if (currentIndex > 0) {
            const prevItem = visibleItems[currentIndex - 1].item;
            setFocusedId(prevItem.nodeId);
            const domEl = document.getElementById(prevItem.id);
            domEl?.focus();
          }
          break;
        }

        case 'ArrowRight': {
          e.preventDefault();
          if (currentItem.hasChildren) {
            if (!currentItem.isExpanded) {
              toggleExpand(currentItem.id);
              setAnnouncement(`Rama expandida: ${currentItem.label}`);
            } else if (currentItem.children.length > 0) {
              const firstChild = currentItem.children[0];
              setFocusedId(firstChild.nodeId);
              document.getElementById(firstChild.id)?.focus();
            }
          }
          break;
        }

        case 'ArrowLeft': {
          e.preventDefault();
          if (currentItem.hasChildren && currentItem.isExpanded) {
            toggleExpand(currentItem.id);
            setAnnouncement(`Rama contraída: ${currentItem.label}`);
          } else if (parentItem) {
            setFocusedId(parentItem.nodeId);
            document.getElementById(parentItem.id)?.focus();
          }
          break;
        }

        case 'Home': {
          e.preventDefault();
          if (visibleItems.length > 0) {
            const first = visibleItems[0].item;
            setFocusedId(first.nodeId);
            document.getElementById(first.id)?.focus();
          }
          break;
        }

        case 'End': {
          e.preventDefault();
          if (visibleItems.length > 0) {
            const last = visibleItems[visibleItems.length - 1].item;
            setFocusedId(last.nodeId);
            document.getElementById(last.id)?.focus();
          }
          break;
        }

        case 'Enter':
        case ' ': {
          e.preventDefault();
          handleSelect(currentItem.nodeId, currentItem.label);
          break;
        }

        case '*': {
          // Expand all descendants
          e.preventDefault();
          if (currentItem.hasChildren) {
            setExpandedIds((prev) => {
              const next = new Set(prev);
              function expandAll(nodes: readonly OutlineTreeItem[]) {
                for (const n of nodes) {
                  if (n.hasChildren) {
                    next.add(n.id);
                    expandAll(n.children);
                  }
                }
              }
              next.add(currentItem.id);
              expandAll(currentItem.children);
              return next;
            });
            setAnnouncement(`Todas las ramas expandidas para ${currentItem.label}`);
          }
          break;
        }
      }
    },
    [visibleItems, toggleExpand, handleSelect]
  );

  const getNodeIcon = (kind: string, isReconvergence?: boolean) => {
    if (isReconvergence) return <GitBranch size={13} className="text-slate-400" />;
    switch (kind) {
      case 'trigger':
        return <Webhook size={13} className="text-teal-600 dark:text-teal-400" />;
      case 'condition':
        return <GitBranch size={13} className="text-purple-600 dark:text-purple-400" />;
      case 'delay':
        return <Clock size={13} className="text-amber-500" />;
      case 'activity':
        return <Globe size={13} className="text-blue-500" />;
      case 'approval':
        return <UserCheck size={13} className="text-purple-500" />;
      case 'end':
        return <CheckCircle2 size={13} className="text-emerald-500" />;
      default:
        return <Folder size={13} className="text-slate-500" />;
    }
  };

  // Recursive Tree Item Renderer
  const renderTreeItems = (
    items: readonly OutlineTreeItem[],
    parentItem?: OutlineTreeItem,
    level = 1
  ) => {
    return items.map((item, index) => {
      const isFocused = item.nodeId === focusedId;
      const isSelected = item.isSelected;
      const isActiveStep = activeRun?.currentStep === item.nodeId;
      const hasError = validationErrors && validationErrors[item.nodeId];

      return (
        <li
          key={item.id}
          id={item.id}
          data-testid={item.id}
          role="treeitem"
          aria-level={item.level}
          aria-setsize={items.length}
          aria-posinset={index + 1}
          aria-selected={isSelected ? 'true' : 'false'}
          aria-expanded={item.hasChildren ? (item.isExpanded ? 'true' : 'false') : undefined}
          aria-current={isActiveStep ? 'step' : undefined}
          tabIndex={isFocused ? 0 : -1}
          onKeyDown={(e) => handleKeyDown(e, item, parentItem)}
          className={`group flex flex-col focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal-600 dark:focus-visible:ring-teal-400 rounded-lg cursor-pointer ${
            isSelected
              ? 'bg-teal-50/80 dark:bg-teal-950/40 text-teal-900 dark:text-teal-100 font-medium'
              : 'hover:bg-slate-100 dark:hover:bg-slate-800 text-slate-700 dark:text-slate-300'
          }`}
        >
          <div
            className="flex items-center gap-1.5 py-1.5 px-2 min-h-[36px]"
            onClick={(e) => {
              e.stopPropagation();
              handleSelect(item.nodeId, item.label);
            }}
          >
            {/* Expand / Collapse Chevron */}
            {item.hasChildren ? (
              <button
                type="button"
                tabIndex={-1}
                aria-hidden="true"
                className="p-0.5 text-slate-400 hover:text-slate-600 dark:hover:text-slate-200"
                onClick={(e) => {
                  e.stopPropagation();
                  toggleExpand(item.id);
                }}
              >
                {item.isExpanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
              </button>
            ) : (
              <span className="w-4 shrink-0" />
            )}

            {/* Edge Branch Label if Present */}
            {Boolean(item.edgeLabel) && (
              <span className="text-[10px] px-1 bg-slate-200 dark:bg-slate-700 rounded text-slate-600 dark:text-slate-300 font-mono">
                {item.edgeLabel}
              </span>
            )}

            {/* Kind Icon */}
            <span className="shrink-0">{getNodeIcon(item.kind, item.isReconvergence)}</span>

            {/* Label */}
            <span className="text-xs truncate flex-1">{item.label}</span>

            {/* Active Execution Indicator */}
            {isActiveStep && (
              <span className="w-2 h-2 rounded-full bg-blue-500 animate-ping shrink-0" title="Paso en ejecución activa" />
            )}

            {/* Validation Error Badge */}
            {hasError && (
              <span title="Error de validación" className="shrink-0">
                <AlertTriangle size={13} className="text-red-500" />
              </span>
            )}
          </div>

          {/* Child Group */}
          {item.hasChildren && item.isExpanded && item.children.length > 0 && (
            <ul
              role="group"
              aria-label={`Ramas de ${item.label}`}
              className="pl-4 border-l border-slate-200 dark:border-slate-800 ml-3.5 my-0.5 flex flex-col gap-0.5"
            >
              {renderTreeItems(item.children, item, level + 1)}
            </ul>
          )}
        </li>
      );
    });
  };

  return (
    <nav
      role="region"
      aria-label="Esquema jerárquico del flujo"
      className={`studio-outline-container flex flex-col h-full bg-white dark:bg-slate-900 border-r border-slate-200 dark:border-slate-800 p-2 overflow-y-auto ${className}`}
    >
      {/* Screen reader live announcer */}
      <div id="outline-live-region" aria-live="polite" aria-atomic="true" className="sr-only">
        {announcement}
      </div>

      {/* Accessible instructions for keyboard and assistive tech */}
      <p id="treeview-instructions" className="sr-only">
        Use las flechas arriba y abajo para navegar los nodos. Use flecha derecha para expandir ramas y flecha izquierda para contraerlas. Presione Enter o Barra espaciadora para seleccionar un nodo. Presione asterisco para expandir todos los hijos.
      </p>

      <div className="flex items-center justify-between pb-2 mb-1 border-b border-slate-100 dark:border-slate-800 px-2">
        <h3 className="text-xs font-bold uppercase tracking-wider text-slate-500 dark:text-slate-400">
          Jerarquía de Pasos
        </h3>
        <span className="text-[10px] text-slate-400">
          {dagGraph.nodes.length} {dagGraph.nodes.length === 1 ? 'nodo' : 'nodos'}
        </span>
      </div>

      <ul
        role="tree"
        aria-label="Jerarquía de nodos del flujo de automatización"
        aria-describedby="treeview-instructions"
        aria-multiselectable="false"
        className="outline-tree flex flex-col gap-0.5 select-none"
      >
        {renderTreeItems(tree)}
      </ul>
    </nav>
  );
};
