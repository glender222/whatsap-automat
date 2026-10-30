import React from 'react';
import { CheckCircle2, Layers3, Pencil, Plus, RefreshCw, X } from 'lucide-react';
import {
  createCatalog,
  createCatalogSection,
  listCatalogs,
  updateCatalog,
  updateCatalogSection,
  updateCatalogSectionStatus,
  updateCatalogStatus,
} from '../services/productService';
import type { Catalog, CatalogSection, CatalogStatus } from '../services/productService';

const emptyCatalogDraft = {
  name: '',
  description: '',
};

const emptySectionDraft = {
  name: '',
  description: '',
  aiInstructions: '',
};

const Field: React.FC<{ label: string; children: React.ReactNode }> = ({ label, children }) => (
  <label className="block">
    <span className="mb-1 block text-xs font-semibold text-[#5B6F66]">{label}</span>
    {children}
  </label>
);

const statusLabel: Record<CatalogStatus, string> = {
  active: 'Activo',
  inactive: 'Inactivo',
  archived: 'Archivado',
};

export default function CatalogsPage() {
  const [catalogs, setCatalogs] = React.useState<Catalog[]>([]);
  const [selectedCatalogId, setSelectedCatalogId] = React.useState<number | null>(null);
  const [catalogDraft, setCatalogDraft] = React.useState(emptyCatalogDraft);
  const [sectionDraft, setSectionDraft] = React.useState(emptySectionDraft);
  const [editingCatalogId, setEditingCatalogId] = React.useState<number | null>(null);
  const [editingSectionId, setEditingSectionId] = React.useState<number | null>(null);
  const [loading, setLoading] = React.useState(false);
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const loadCatalogs = React.useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await listCatalogs();
      setCatalogs(data);
      setSelectedCatalogId((current) => {
        if (current && data.some((catalog) => catalog.id === current)) return current;
        return data.find((catalog) => catalog.status === 'active')?.id || data[0]?.id || null;
      });
    } catch (err: any) {
      setError(err?.response?.data?.message || err?.message || 'No se pudieron cargar los catalogos');
    } finally {
      setLoading(false);
    }
  }, []);

  React.useEffect(() => {
    loadCatalogs();
  }, [loadCatalogs]);

  const selectedCatalog = catalogs.find((catalog) => catalog.id === selectedCatalogId) || null;

  const resetCatalogDraft = () => {
    setCatalogDraft(emptyCatalogDraft);
    setEditingCatalogId(null);
  };

  const resetSectionDraft = () => {
    setSectionDraft(emptySectionDraft);
    setEditingSectionId(null);
  };

  const handleCatalogSave = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!catalogDraft.name.trim()) return;
    setSaving(true);
    setError(null);
    try {
      const savedCatalog = editingCatalogId
        ? await updateCatalog(editingCatalogId, catalogDraft)
        : await createCatalog({ ...catalogDraft, status: 'active', aiEnabled: true });
      setSelectedCatalogId(savedCatalog.id);
      resetCatalogDraft();
      await loadCatalogs();
    } catch (err: any) {
      setError(err?.response?.data?.message || err?.message || 'No se pudo guardar el catalogo');
    } finally {
      setSaving(false);
    }
  };

  const handleCatalogEdit = (catalog: Catalog) => {
    setEditingCatalogId(catalog.id);
    setCatalogDraft({
      name: catalog.name,
      description: catalog.description || '',
    });
  };

  const handleCatalogStatus = async (catalog: Catalog) => {
    const nextStatus: CatalogStatus = catalog.status === 'active' ? 'inactive' : 'active';
    setError(null);
    try {
      await updateCatalogStatus(catalog.id, nextStatus);
      await loadCatalogs();
    } catch (err: any) {
      setError(err?.response?.data?.message || err?.message || 'No se pudo actualizar el catalogo');
    }
  };

  const handleSectionSave = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!selectedCatalog || !sectionDraft.name.trim()) return;
    setSaving(true);
    setError(null);
    try {
      if (editingSectionId) {
        await updateCatalogSection(editingSectionId, sectionDraft);
      } else {
        await createCatalogSection(selectedCatalog.id, {
          ...sectionDraft,
          status: 'active',
          aiEnabled: true,
        });
      }
      resetSectionDraft();
      await loadCatalogs();
    } catch (err: any) {
      setError(err?.response?.data?.message || err?.message || 'No se pudo guardar la seccion');
    } finally {
      setSaving(false);
    }
  };

  const handleSectionEdit = (section: CatalogSection) => {
    setEditingSectionId(section.id);
    setSectionDraft({
      name: section.name,
      description: section.description || '',
      aiInstructions: section.aiInstructions || '',
    });
  };

  const handleSectionStatus = async (section: CatalogSection) => {
    const nextStatus: CatalogStatus = section.status === 'active' ? 'inactive' : 'active';
    setError(null);
    try {
      await updateCatalogSectionStatus(section.id, nextStatus);
      await loadCatalogs();
    } catch (err: any) {
      setError(err?.response?.data?.message || err?.message || 'No se pudo actualizar la seccion');
    }
  };

  return (
    <main className="h-[calc(100vh-96px)] overflow-hidden bg-[#F7FAF8] p-4 text-[#10231C]">
      <div className="grid h-full gap-4 lg:grid-cols-[360px_1fr]">
        <section className="admin-scrollbar overflow-y-auto rounded-2xl border border-[#D9E5DF] bg-white p-5 shadow-sm">
          <div className="mb-4 flex items-center justify-between gap-3">
            <div>
              <h3 className="text-xl font-bold text-[#10231C]">Gestionar catalogos</h3>
              <p className="text-sm text-[#5B6F66]">Crea catalogos y ordena sus secciones.</p>
            </div>
            <button type="button" onClick={loadCatalogs} className="admin-icon-button" aria-label="Actualizar catalogos">
              <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
            </button>
          </div>

          {error && (
            <div className="mb-4 rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
              {error}
            </div>
          )}

          <form onSubmit={handleCatalogSave} className="space-y-3 rounded-xl border border-[#D9E5DF] bg-[#F7FAF8] p-4">
            <div className="flex items-center justify-between gap-2">
              <h4 className="text-sm font-bold text-[#10231C]">{editingCatalogId ? 'Editar catalogo' : 'Nuevo catalogo'}</h4>
              {editingCatalogId && (
                <button type="button" className="admin-icon-button h-8 w-8" onClick={resetCatalogDraft} aria-label="Cancelar edicion de catalogo">
                  <X className="h-4 w-4" />
                </button>
              )}
            </div>
            <Field label="Nombre del catalogo">
              <input className="admin-control" value={catalogDraft.name} placeholder="Ej. Cursos, Productos, Planes" onChange={(event) => setCatalogDraft({ ...catalogDraft, name: event.target.value })} />
            </Field>
            <Field label="Descripcion">
              <textarea className="admin-textarea min-h-[84px]" value={catalogDraft.description} placeholder="Descripcion corta para el equipo y la IA" onChange={(event) => setCatalogDraft({ ...catalogDraft, description: event.target.value })} />
            </Field>
            <button type="submit" disabled={saving || !catalogDraft.name.trim()} className="admin-button-primary w-full">
              <Plus className="h-4 w-4" />
              {editingCatalogId ? 'Guardar catalogo' : 'Crear catalogo'}
            </button>
          </form>

          <div className="mt-4 space-y-2">
            {catalogs.length === 0 ? (
              <div className="rounded-xl border border-dashed border-[#D9E5DF] bg-[#F7FAF8] p-4 text-sm text-[#5B6F66]">
                Todavia no hay catalogos registrados.
              </div>
            ) : catalogs.map((catalog) => {
              const selected = selectedCatalogId === catalog.id;
              return (
                <button
                  key={catalog.id}
                  type="button"
                  onClick={() => setSelectedCatalogId(catalog.id)}
                  className={`w-full rounded-xl border p-3 text-left transition ${selected ? 'border-[#128C7E] bg-[#DDF4EF]' : 'border-[#D9E5DF] bg-white hover:bg-[#EEF4F1]'}`}
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="truncate text-sm font-bold text-[#10231C]">{catalog.name}</p>
                      <p className="mt-1 line-clamp-2 text-xs text-[#5B6F66]">{catalog.description || 'Sin descripcion'}</p>
                    </div>
                    <span className={`rounded-full px-2 py-0.5 text-[11px] font-bold ${catalog.status === 'active' ? 'bg-[#E4FBEF] text-[#128C7E]' : 'bg-[#EEF4F1] text-[#5B6F66]'}`}>
                      {statusLabel[catalog.status]}
                    </span>
                  </div>
                  <p className="mt-2 text-xs font-semibold text-[#5B6F66]">{catalog.sections.length} secciones</p>
                </button>
              );
            })}
          </div>
        </section>

        <section className="admin-scrollbar overflow-y-auto rounded-2xl border border-[#D9E5DF] bg-white p-5 shadow-sm">
          {selectedCatalog ? (
            <>
              <div className="mb-5 flex flex-wrap items-start justify-between gap-3">
                <div>
                  <div className="flex items-center gap-2">
                    <Layers3 className="h-5 w-5 text-[#128C7E]" />
                    <h3 className="text-xl font-bold text-[#10231C]">{selectedCatalog.name}</h3>
                  </div>
                  <p className="mt-1 max-w-2xl text-sm text-[#5B6F66]">{selectedCatalog.description || 'Catalogo sin descripcion.'}</p>
                </div>
                <div className="flex flex-wrap gap-2">
                  <button type="button" className="admin-button-secondary" onClick={() => handleCatalogEdit(selectedCatalog)}>
                    <Pencil className="h-4 w-4" />
                    Editar
                  </button>
                  <button type="button" className="admin-button-secondary" onClick={() => handleCatalogStatus(selectedCatalog)}>
                    {selectedCatalog.status === 'active' ? 'Inactivar' : 'Activar'}
                  </button>
                </div>
              </div>

              <form onSubmit={handleSectionSave} className="mb-5 grid gap-3 rounded-xl border border-[#D9E5DF] bg-[#F7FAF8] p-4 md:grid-cols-[1fr_1fr_auto]">
                <Field label={editingSectionId ? 'Editar seccion' : 'Nueva seccion'}>
                  <input className="admin-control" value={sectionDraft.name} placeholder="Ej. Basico, Premium, Accesorios" onChange={(event) => setSectionDraft({ ...sectionDraft, name: event.target.value })} />
                </Field>
                <Field label="Descripcion">
                  <input className="admin-control" value={sectionDraft.description} placeholder="Descripcion breve" onChange={(event) => setSectionDraft({ ...sectionDraft, description: event.target.value })} />
                </Field>
                <div className="flex items-end gap-2">
                  <button type="submit" disabled={saving || !sectionDraft.name.trim()} className="admin-button-primary">
                    {editingSectionId ? 'Guardar' : 'Crear'}
                  </button>
                  {editingSectionId && (
                    <button type="button" onClick={resetSectionDraft} className="admin-icon-button" aria-label="Cancelar edicion de seccion">
                      <X className="h-4 w-4" />
                    </button>
                  )}
                </div>
                <div className="md:col-span-3">
                  <Field label="Guia IA de la seccion">
                    <textarea className="admin-textarea min-h-[84px]" value={sectionDraft.aiInstructions} placeholder="Preguntas frecuentes, recomendaciones y restricciones para esta seccion" onChange={(event) => setSectionDraft({ ...sectionDraft, aiInstructions: event.target.value })} />
                  </Field>
                </div>
              </form>

              <div className="space-y-3">
                {selectedCatalog.sections.length === 0 ? (
                  <div className="rounded-xl border border-dashed border-[#D9E5DF] bg-[#F7FAF8] p-6 text-center text-sm text-[#5B6F66]">
                    Este catalogo todavia no tiene secciones.
                  </div>
                ) : selectedCatalog.sections.map((section) => (
                  <article key={section.id} className="rounded-xl border border-[#D9E5DF] bg-white p-4">
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-2">
                          <h4 className="text-sm font-bold text-[#10231C]">{section.name}</h4>
                          <span className={`rounded-full px-2 py-0.5 text-[11px] font-bold ${section.status === 'active' ? 'bg-[#E4FBEF] text-[#128C7E]' : 'bg-[#EEF4F1] text-[#5B6F66]'}`}>
                            {statusLabel[section.status]}
                          </span>
                          {section.aiEnabled && <CheckCircle2 className="h-4 w-4 text-[#25D366]" />}
                        </div>
                        <p className="mt-1 text-sm text-[#5B6F66]">{section.description || 'Sin descripcion'}</p>
                        {section.aiInstructions && <p className="mt-2 rounded-lg bg-[#EEF4F1] px-3 py-2 text-xs text-[#5B6F66]">{section.aiInstructions}</p>}
                      </div>
                      <div className="flex gap-2">
                        <button type="button" className="admin-button-secondary h-9 px-3" onClick={() => handleSectionEdit(section)}>
                          Editar
                        </button>
                        <button type="button" className="admin-button-secondary h-9 px-3" onClick={() => handleSectionStatus(section)}>
                          {section.status === 'active' ? 'Inactivar' : 'Activar'}
                        </button>
                      </div>
                    </div>
                  </article>
                ))}
              </div>
            </>
          ) : (
            <div className="flex h-full min-h-[420px] flex-col items-center justify-center rounded-xl border border-dashed border-[#D9E5DF] bg-[#F7FAF8] px-6 text-center">
              <Layers3 className="mb-3 h-10 w-10 text-[#128C7E]" />
              <h3 className="text-lg font-bold text-[#10231C]">Crea tu primer catalogo</h3>
              <p className="mt-1 max-w-md text-sm text-[#5B6F66]">Los productos se asignan a catalogos y secciones desde la pantalla de productos.</p>
            </div>
          )}
        </section>
      </div>
    </main>
  );
}
