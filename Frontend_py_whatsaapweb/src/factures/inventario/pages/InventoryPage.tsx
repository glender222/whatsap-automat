import React from 'react';
import {
  AlertTriangle,
  ArrowLeft,
  ArrowRight,
  Bot,
  Box,
  ChevronDown,
  CheckCircle2,
  Edit2,
  GraduationCap,
  Grid2X2,
  ImageIcon,
  Infinity,
  List,
  Minus,
  MonitorDown,
  Package,
  Plus,
  RefreshCw,
  Repeat,
  Search,
  SlidersHorizontal,
  Sparkles,
  Users,
  X,
} from 'lucide-react';
import { Link } from 'react-router-dom';
import {
  adjustStock,
  createProduct,
  listCatalogs,
  listProducts,
  updateProduct,
  uploadCommercialItemImage,
} from '../services/productService';
import type {
  AvailabilityType,
  Catalog,
  CatalogAssignmentInput,
  CommercialItemType,
  Product,
  ProductImage,
  ProductInput,
} from '../services/productService';
import { getResourceUrl } from '../../../shared/utils/urls';

type CatalogForm = {
  catalogAssignments: CatalogAssignmentInput[];
  name: string;
  sku: string;
  imageUrl: string;
  images: ProductImage[];
  description: string;
  price: string;
  priceMode: Product['priceMode'];
  status: Product['status'];
  itemType: CommercialItemType;
  availabilityType: AvailabilityType;
  unitLabel: string;
  stockAvailable: string;
  capacity: string;
  reservationTtlMinutes: string;
  aiEnabled: boolean;
  requiresHumanApproval: boolean;
  aiDescription: string;
  aiSalesInstructions: string;
};

type ViewMode = 'cards' | 'table';
type CatalogFilter = 'all' | number;
type SectionFilter = 'all' | number;
type AiFilter = 'all' | 'enabled' | 'disabled';
type FormStep = 1 | 2 | 3;

const itemTypeLabels: Record<CommercialItemType, string> = {
  physical_product: 'Producto fisico',
  digital_product: 'Digital',
  service: 'Servicio',
  course: 'Curso',
  subscription: 'Suscripcion',
  custom: 'Personalizado',
};

const itemTypeIcons: Record<CommercialItemType, typeof Package> = {
  physical_product: Box,
  digital_product: MonitorDown,
  service: Users,
  course: GraduationCap,
  subscription: Repeat,
  custom: Package,
};

const availabilityLabels: Record<AvailabilityType, string> = {
  stock: 'Unidades limitadas',
  unlimited: 'Ilimitado',
  capacity: 'Cupos limitados',
  manual: 'Aprobacion manual',
  schedule: 'Agenda / Horario',
};

const availabilityHelp: Record<AvailabilityType, string> = {
  stock: 'El sistema descuenta y reserva unidades.',
  unlimited: 'No depende de stock ni cupos.',
  capacity: 'Ideal para cursos, eventos o servicios con cupos.',
  manual: 'Una persona debe revisar antes de confirmar.',
  schedule: 'Ideal para reservas, citas o servicios por agenda.',
};

const defaultAvailabilityByType: Record<CommercialItemType, AvailabilityType> = {
  physical_product: 'stock',
  digital_product: 'unlimited',
  service: 'manual',
  course: 'capacity',
  subscription: 'unlimited',
  custom: 'manual',
};

const defaultUnitByType: Record<CommercialItemType, string> = {
  physical_product: 'unidad',
  digital_product: 'acceso',
  service: 'sesion',
  course: 'cupo',
  subscription: 'mes',
  custom: 'item',
};

const emptyForm: CatalogForm = {
  catalogAssignments: [],
  name: '',
  sku: '',
  imageUrl: '',
  images: [],
  description: '',
  price: '',
  priceMode: 'fixed',
  status: 'draft',
  itemType: 'physical_product',
  availabilityType: 'stock',
  unitLabel: 'unidad',
  stockAvailable: '0',
  capacity: '',
  reservationTtlMinutes: '',
  aiEnabled: true,
  requiresHumanApproval: false,
  aiDescription: '',
  aiSalesInstructions: '',
};

function toPayload(form: CatalogForm, statusOverride?: Product['status']): ProductInput {
  const usesQuantity = ['stock', 'capacity'].includes(form.availabilityType);
  return {
    name: form.name,
    sku: form.sku || undefined,
    description: form.description || undefined,
    price: form.price ? Number(form.price) : null,
    priceMode: form.priceMode,
    status: statusOverride || form.status,
    itemType: form.itemType,
    availabilityType: form.availabilityType,
    unitLabel: form.unitLabel || null,
    stockAvailable: usesQuantity ? Number(form.stockAvailable || 0) : 0,
    capacity: form.availabilityType === 'capacity' && form.capacity ? Number(form.capacity) : null,
    reservationTtlMinutes: form.reservationTtlMinutes ? Number(form.reservationTtlMinutes) : null,
    aiEnabled: form.aiEnabled,
    requiresHumanApproval: form.requiresHumanApproval || form.availabilityType === 'manual',
    aiDescription: form.aiDescription || null,
    aiSalesInstructions: form.aiSalesInstructions || null,
    catalogAssignments: form.catalogAssignments,
    imageUrl: form.imageUrl || null,
    imageAltText: form.name || null,
    images: form.images.map((image, index) => ({
      imageUrl: image.url,
      imageAltText: image.altText || form.name || null,
      sortOrder: image.sortOrder ?? index,
      isPrimary: image.isPrimary === true || index === 0,
      mimeType: image.mimeType || null,
      sizeBytes: image.sizeBytes || null,
    })),
  };
}

function fromProduct(product: Product): CatalogForm {
  const assignments = product.catalogs.map((catalog) => ({
    catalogId: catalog.id,
    sectionId: product.sections.find((section) => section.catalogId === catalog.id)?.id || null,
  }));
  return {
    catalogAssignments: assignments,
    name: product.name,
    sku: product.sku || '',
    imageUrl: product.primaryImage?.url || product.imageUrl || '',
    images: product.images?.length ? product.images : (product.imageUrl ? [{ url: product.imageUrl, altText: product.imageAltText || product.name, isPrimary: true, sortOrder: 0 }] : []),
    description: product.description || '',
    price: product.price === null ? '' : String(product.price),
    priceMode: product.priceMode || (product.price === null ? 'consult' : 'fixed'),
    status: product.status,
    itemType: product.itemType,
    availabilityType: product.availabilityType,
    unitLabel: product.unitLabel || '',
    stockAvailable: String(product.stockAvailable || 0),
    capacity: product.capacity === null ? '' : String(product.capacity),
    reservationTtlMinutes: product.reservationTtlMinutes === null ? '' : String(product.reservationTtlMinutes),
    aiEnabled: product.aiEnabled,
    requiresHumanApproval: product.requiresHumanApproval,
    aiDescription: product.aiDescription || '',
    aiSalesInstructions: product.aiSalesInstructions || '',
  };
}

function formatPrice(product: Product): string {
  if (product.priceMode === 'free') return 'Gratis';
  if (product.priceMode === 'consult') return 'Consultar';
  if (product.price === null) return 'Por cotizar';
  const amount = `${product.currency} ${Number(product.price).toLocaleString('es-PE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  return product.priceMode === 'from' ? `Desde ${amount}` : amount;
}

function availabilitySummary(product: Product): string {
  if (product.availabilityType === 'manual') return 'Revision humana';
  if (product.availabilityType === 'schedule') return 'Por agenda';
  if (product.availabilityType === 'unlimited') return 'Ilimitado';
  const unit = product.availabilityType === 'capacity' ? 'cupos' : 'unidades';
  return `${product.stockAvailable} ${unit}`;
}

function availabilityTone(product: Product): { text: string; className: string; dot: string; icon?: React.ReactNode } {
  if (product.availabilityType === 'unlimited') {
    return { text: 'Ilimitado', className: 'text-[#5B6F66]', dot: 'bg-[#128C7E]', icon: <Infinity className="h-3.5 w-3.5" /> };
  }
  if (product.availabilityType === 'manual') {
    return { text: 'Revision', className: 'text-[#2563EB]', dot: 'bg-[#2563EB]' };
  }
  if (product.availabilityType === 'schedule') {
    return { text: 'Agenda', className: 'text-[#2563EB]', dot: 'bg-[#2563EB]' };
  }
  if (product.stockAvailable <= 0) {
    return { text: 'Agotado', className: 'text-[#DC2626]', dot: 'bg-[#DC2626]' };
  }
  if (product.stockAvailable <= 3) {
    return { text: availabilitySummary(product), className: 'text-[#0E766A]', dot: 'bg-[#0E766A]' };
  }
  return { text: availabilitySummary(product), className: 'text-[#5B6F66]', dot: 'bg-[#25D366]' };
}

function productReadiness(product: Product): { label: string; className: string; showBot: boolean } {
  if (product.status !== 'active') return { label: product.status === 'draft' ? 'Borrador' : 'Inactivo', className: 'bg-[#EEF4F1] text-[#5B6F66]', showBot: false };
  if (!product.aiEnabled) return { label: 'IA OFF', className: 'bg-[#EEF4F1] text-[#5B6F66]', showBot: false };
  if (product.aiReadiness === 'missing_catalog') return { label: 'Sin catalogo', className: 'bg-[#EEF4F1] text-[#5B6F66]', showBot: false };
  if (product.aiReadiness === 'missing_section') return { label: 'Sin seccion', className: 'bg-[#EEF4F1] text-[#5B6F66]', showBot: false };
  if (product.aiReadiness === 'missing_ai_context') return { label: 'Revisar IA', className: 'bg-[#DDF4EF] text-[#0E766A]', showBot: false };
  return { label: 'IA ON', className: 'bg-[#E4FBEF] text-[#128C7E]', showBot: true };
}

const Field: React.FC<{ label: string; children: React.ReactNode; className?: string }> = ({ label, children, className = '' }) => (
  <label className={`block ${className}`}>
    <span className="mb-1 block text-xs font-semibold text-[#5B6F66]">{label}</span>
    {children}
  </label>
);

const SelectWrap: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <div className="relative">
    {children}
    <ChevronDown className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[#5B6F66]" />
  </div>
);

const StepCard: React.FC<{ step: number; title: string; icon?: React.ReactNode; ai?: boolean; children: React.ReactNode; footer?: React.ReactNode }> = ({ step, title, icon, ai, children, footer }) => (
  <section className={`relative overflow-hidden rounded-xl border p-5 shadow-sm ${ai ? 'border-[#25D366]/40 bg-white' : 'border-[#D9E5DF] bg-white'}`}>
    {ai && <div className="pointer-events-none absolute right-0 top-0 h-24 w-24 rounded-bl-full bg-[#E4FBEF]" />}
    <div className="mb-4 flex items-center gap-3 border-b border-[#D9E5DF] pb-3">
      <div className={`flex h-8 w-8 items-center justify-center rounded-full text-sm font-bold ${ai ? 'bg-[#25D366] text-[#10231C]' : 'bg-[#DDF4EF] text-[#128C7E]'}`}>{step}</div>
      <h4 className="flex items-center gap-2 text-sm font-bold text-[#10231C]">
        {title}
        {icon}
      </h4>
    </div>
    <div className="space-y-4">{children}</div>
    {footer}
  </section>
);

const InventoryPage: React.FC = () => {
  const [catalogs, setCatalogs] = React.useState<Catalog[]>([]);
  const [products, setProducts] = React.useState<Product[]>([]);
  const [loading, setLoading] = React.useState(false);
  const [saving, setSaving] = React.useState(false);
  const imageInput = React.useRef<HTMLInputElement>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [editingId, setEditingId] = React.useState<number | null>(null);
  const [viewMode, setViewMode] = React.useState<ViewMode>('cards');
  const [selectedCatalogId] = React.useState<CatalogFilter>('all');
  const [selectedSectionId, setSelectedSectionId] = React.useState<SectionFilter>('all');
  const [typeFilter, setTypeFilter] = React.useState<'all' | CommercialItemType>('all');
  const [statusFilter, setStatusFilter] = React.useState<'all' | Product['status']>('all');
  const [aiFilter, setAiFilter] = React.useState<AiFilter>('all');
  const [searchTerm, setSearchTerm] = React.useState('');
  const [form, setForm] = React.useState<CatalogForm>(emptyForm);
  const [showFilters, setShowFilters] = React.useState(false);
  const [formStep, setFormStep] = React.useState<FormStep>(1);
  const [uploadingImage, setUploadingImage] = React.useState(false);

  const loadCatalogs = React.useCallback(async () => {
    setCatalogs(await listCatalogs());
  }, []);

  const loadProducts = React.useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setProducts(await listProducts({
        q: searchTerm,
        catalogId: selectedCatalogId,
        sectionId: selectedSectionId,
        type: typeFilter,
        status: statusFilter,
        aiEnabled: aiFilter === 'all' ? 'all' : aiFilter === 'enabled',
      }));
    } catch (err: any) {
      setError(err?.response?.data?.message || err?.message || 'No se pudo cargar el catalogo');
    } finally {
      setLoading(false);
    }
  }, [aiFilter, searchTerm, selectedCatalogId, selectedSectionId, statusFilter, typeFilter]);

  React.useEffect(() => {
    loadCatalogs().catch((err: any) => setError(err?.response?.data?.message || err?.message || 'No se pudieron cargar los catalogos'));
  }, [loadCatalogs]);

  React.useEffect(() => {
    loadProducts();
  }, [loadProducts]);

  React.useEffect(() => {
    setForm((current) => {
      if (current.catalogAssignments.length > 0 || catalogs.length === 0) return current;
      const firstActive = catalogs.find((catalog) => catalog.status === 'active') || catalogs[0];
      return { ...current, catalogAssignments: [{ catalogId: firstActive.id, sectionId: firstActive.sections?.find((section) => section.status === 'active')?.id || null }] };
    });
  }, [catalogs]);

  const summary = React.useMemo(() => ({
    total: products.length,
    aiEnabled: products.filter((product) => product.aiEnabled && product.status === 'active').length,
    needsInfo: products.filter((product) => product.aiEnabled && product.status === 'active' && !product.aiDescription).length,
    withoutCatalog: products.filter((product) => product.catalogs.length === 0).length,
  }), [products]);

  const usesQuantity = ['stock', 'capacity'].includes(form.availabilityType);

  const refreshAll = async () => {
    await Promise.all([loadCatalogs(), loadProducts()]);
  };

  const resetForm = () => {
    setEditingId(null);
    setForm({
      ...emptyForm,
      catalogAssignments: catalogs.length ? [{
        catalogId: catalogs.find((catalog) => catalog.status === 'active')?.id || catalogs[0].id,
        sectionId: (catalogs.find((catalog) => catalog.status === 'active') || catalogs[0]).sections?.find((section) => section.status === 'active')?.id || null,
      }] : [],
    });
    setFormStep(1);
  };

  const handleTypeChange = (itemType: CommercialItemType) => {
    const nextAvailability = defaultAvailabilityByType[itemType];
    setForm((current) => ({
      ...current,
      itemType,
      availabilityType: nextAvailability,
      unitLabel: defaultUnitByType[itemType],
      requiresHumanApproval: nextAvailability === 'manual',
      stockAvailable: nextAvailability === 'unlimited' || nextAvailability === 'manual' ? '0' : current.stockAvailable,
    }));
  };

  const toggleFormCatalog = (catalogId: number) => {
    setForm((current) => {
      const exists = current.catalogAssignments.some((item) => item.catalogId === catalogId);
      const catalog = catalogs.find((item) => item.id === catalogId);
      return {
        ...current,
        catalogAssignments: exists
          ? current.catalogAssignments.filter((item) => item.catalogId !== catalogId)
          : [...current.catalogAssignments, { catalogId, sectionId: catalog?.sections?.find((section) => section.status === 'active')?.id || null }],
      };
    });
  };

  const setAssignmentSection = (catalogId: number, sectionId: number | null) => {
    setForm((current) => ({
      ...current,
      catalogAssignments: current.catalogAssignments.map((assignment) => (
        assignment.catalogId === catalogId ? { ...assignment, sectionId } : assignment
      )),
    }));
  };

  const saveProduct = async (statusOverride?: Product['status']) => {
    if (!form.name.trim()) {
      setError('Nombre de oferta requerido');
      return;
    }
    if ((statusOverride || form.status) === 'active' && form.images.length === 0 && !form.imageUrl) {
      setError('Agrega una imagen principal antes de publicar la oferta');
      setFormStep(1);
      return;
    }
    setError(null);
    setSaving(true);
    try {
      if (editingId) {
        await updateProduct(editingId, toPayload(form, statusOverride));
      } else {
        await createProduct(toPayload(form, statusOverride));
      }
      resetForm();
      await refreshAll();
    } catch (err: any) {
      setError(err?.response?.data?.message || err?.message || 'No se pudo guardar la oferta');
    } finally {
      setSaving(false);
    }
  };

  const handleEdit = (product: Product) => {
    setEditingId(product.id);
    setForm(fromProduct(product));
    setFormStep(1);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const handleAdjust = async (product: Product, delta: number) => {
    setError(null);
    try {
      const updated = await adjustStock(product.id, delta, delta > 0 ? 'Ingreso manual de disponibilidad' : 'Salida manual de disponibilidad');
      setProducts((current) => current.map((item) => item.id === product.id ? updated : item));
    } catch (err: any) {
      setError(err?.response?.data?.message || err?.message || 'No se pudo ajustar la disponibilidad');
    }
  };

  const handleToggleAi = async (product: Product) => {
    setError(null);
    try {
      const updated = await updateProduct(product.id, { aiEnabled: !product.aiEnabled });
      setProducts((current) => current.map((item) => item.id === product.id ? updated : item));
    } catch (err: any) {
      setError(err?.response?.data?.message || err?.message || 'No se pudo actualizar el uso con IA');
    }
  };

  const resolveProductImage = (imageUrl?: string | null) => {
    if (!imageUrl) return '';
    if (/^https?:\/\//i.test(imageUrl)) return imageUrl;
    return getResourceUrl(imageUrl);
  };

  const handleImageUpload = async (file: File | null) => {
    if (!file) return;
    if (form.images.length >= 8) {
      setError('La galeria admite hasta 8 imagenes.');
      return;
    }
    if (!/^image\/(jpeg|png|webp|gif)$/i.test(file.type)) {
      setError('Solo puedes subir imagenes JPG, PNG, WEBP o GIF');
      return;
    }
    if (file.size > 8 * 1024 * 1024) {
      setError('La imagen no puede superar 8 MB');
      return;
    }
    setUploadingImage(true);
    setError(null);
    try {
      const uploaded = await uploadCommercialItemImage(file, form.name || file.name);
      setForm((current) => ({
        ...current,
        imageUrl: current.imageUrl || uploaded.imageUrl,
        images: [
          ...current.images,
          {
            url: uploaded.imageUrl,
            altText: uploaded.imageAltText || current.name || file.name,
            sortOrder: current.images.length,
            isPrimary: current.images.length === 0,
            mimeType: uploaded.mimeType,
            sizeBytes: uploaded.size,
          },
        ].slice(0, 8),
      }));
    } catch (err: any) {
      setError(err?.response?.data?.message || err?.message || 'No se pudo subir la imagen');
    } finally {
      setUploadingImage(false);
    }
  };

  const setPrimaryFormImage = (index: number) => {
    setForm((current) => {
      const images = current.images.map((image, itemIndex) => ({ ...image, isPrimary: itemIndex === index }));
      return {
        ...current,
        images,
        imageUrl: images[index]?.url || current.imageUrl,
      };
    });
  };

  const removeFormImage = (index: number) => {
    setForm((current) => {
      const images = current.images.filter((_, itemIndex) => itemIndex !== index).map((image, itemIndex) => ({
        ...image,
        sortOrder: itemIndex,
        isPrimary: itemIndex === 0 ? true : image.isPrimary,
      }));
      const primary = images.find((image) => image.isPrimary) || images[0] || null;
      return {
        ...current,
        images: primary ? images.map((image) => ({ ...image, isPrimary: image.url === primary.url })) : [],
        imageUrl: primary?.url || '',
      };
    });
  };

  const moveFormImage = (index: number, direction: -1 | 1) => {
    setForm((current) => {
      const nextIndex = index + direction;
      if (nextIndex < 0 || nextIndex >= current.images.length) return current;
      const images = [...current.images];
      const [image] = images.splice(index, 1);
      images.splice(nextIndex, 0, image);
      return {
        ...current,
        images: images.map((item, itemIndex) => ({ ...item, sortOrder: itemIndex })),
      };
    });
  };

  const activeCatalogForSections = selectedCatalogId === 'all'
    ? catalogs.find((catalog) => catalog.status === 'active') || catalogs[0]
    : catalogs.find((catalog) => catalog.id === selectedCatalogId);

  const visibleSections = activeCatalogForSections?.sections || [];

  const renderCatalogBadges = (product: Product) => (
    product.catalogs.length === 0 ? (
      <span className="rounded border border-dashed border-[#5B6F66] bg-[#EEF4F1] px-2 py-0.5 text-[11px] font-semibold text-[#5B6F66]">Sin catalogo</span>
    ) : (
      <span className="inline-flex max-w-[220px] truncate rounded bg-[#EEF4F1] px-2 py-0.5 text-[11px] font-semibold text-[#10231C]">
        {product.catalogs[0].name}{product.catalogs.length > 1 ? ` +${product.catalogs.length - 1}` : ''}
      </span>
    )
  );

  const renderSectionBadge = (product: Product) => (
    product.sections.length === 0 ? (
      <span className="rounded border border-dashed border-[#D9E5DF] bg-white px-2 py-0.5 text-[11px] font-semibold text-[#5B6F66]">Sin seccion</span>
    ) : (
      <span className="inline-flex max-w-[220px] truncate rounded bg-[#DDF4EF] px-2 py-0.5 text-[11px] font-semibold text-[#128C7E]">
        {product.sections[0].name}{product.sections.length > 1 ? ` +${product.sections.length - 1}` : ''}
      </span>
    )
  );

  const renderProductThumb = (product: Product, className = 'h-12 w-12') => {
    const TypeIcon = itemTypeIcons[product.itemType];
    const imageUrl = product.primaryImage?.url || product.imageUrl;
    if (imageUrl) {
      return (
        <img
          src={resolveProductImage(imageUrl)}
          alt={product.primaryImage?.altText || product.imageAltText || product.name}
          className={`${className} shrink-0 rounded-lg border border-[#D9E5DF] object-cover`}
        />
      );
    }
    return (
      <div className={`${className} flex shrink-0 items-center justify-center rounded-lg border border-[#D9E5DF] bg-[#EEF4F1] text-[#5B6F66]`}>
        <TypeIcon className="h-5 w-5" />
      </div>
    );
  };

  const renderProductActions = (product: Product) => {
    const canAdjust = ['stock', 'capacity'].includes(product.availabilityType);
    return (
      <div className="mt-3 flex items-center justify-between gap-2 border-t border-[#D9E5DF] pt-3">
        <button type="button" onClick={() => handleEdit(product)} className="rounded-lg border border-[#D9E5DF] px-3 py-1.5 text-xs font-semibold text-[#10231C] transition hover:bg-[#EEF4F1]">
          Editar
        </button>
        {canAdjust && (
          <div className="flex items-center gap-1">
            <button type="button" aria-label={`Quitar disponibilidad de ${product.name}`} onClick={() => handleAdjust(product, -1)} className="admin-icon-button h-8 w-8">
              <Minus className="h-4 w-4" />
            </button>
            <button type="button" aria-label={`Agregar disponibilidad a ${product.name}`} onClick={() => handleAdjust(product, 1)} className="admin-icon-button h-8 w-8">
              <Plus className="h-4 w-4" />
            </button>
          </div>
        )}
      </div>
    );
  };

  const canContinueStep1 = form.name.trim().length > 0 && form.catalogAssignments.length > 0;
  const canContinueStep2 = !usesQuantity || Number(form.stockAvailable || 0) >= 0;
  const stepLabels = [
    { step: 1 as FormStep, title: 'Catalogo y oferta' },
    { step: 2 as FormStep, title: 'Disponibilidad' },
    { step: 3 as FormStep, title: 'IA y publicacion' },
  ];

  const renderStepper = () => (
    <div className="mb-4 grid grid-cols-3 gap-2">
      {stepLabels.map((item) => {
        const active = formStep === item.step;
        const completed = formStep > item.step;
        return (
          <button
            key={item.step}
            type="button"
            onClick={() => setFormStep(item.step)}
            className={`flex min-h-[58px] items-center gap-2 rounded-xl border px-3 text-left transition ${
              active
                ? 'border-[#128C7E] bg-[#DDF4EF] text-[#10231C]'
                : completed
                  ? 'border-[#25D366]/50 bg-white text-[#128C7E]'
                  : 'border-[#D9E5DF] bg-white text-[#5B6F66]'
            }`}
          >
            <span className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-xs font-bold ${
              completed ? 'bg-[#25D366] text-white' : active ? 'bg-[#128C7E] text-white' : 'bg-[#EEF4F1] text-[#5B6F66]'
            }`}>
              {completed ? <CheckCircle2 className="h-4 w-4" /> : item.step}
            </span>
            <span className="hidden text-xs font-bold leading-tight sm:block">{item.title}</span>
          </button>
        );
      })}
    </div>
  );

  const renderCards = () => (
    <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
      {products.map((product) => {
        const readiness = productReadiness(product);
        const tone = availabilityTone(product);
        const isWarning = product.aiReadiness !== 'ready' || (['stock', 'capacity'].includes(product.availabilityType) && product.stockAvailable <= 0);
        return (
          <article key={product.id} className={`group relative cursor-pointer overflow-hidden rounded-xl border bg-white p-4 transition-shadow hover:shadow-md ${isWarning ? 'border-[#F59E0B]/30 bg-[#F59E0B]/5' : 'border-[#D9E5DF]'}`}>
            <div className="absolute right-2 top-2 flex gap-1">
              <button type="button" onClick={() => handleToggleAi(product)} className={`flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-bold ${readiness.className}`}>
                {readiness.showBot && <Sparkles className="h-3 w-3" />}
                {readiness.label}
              </button>
            </div>
            <div className="mb-3 flex items-start gap-3">
              {renderProductThumb(product)}
              <div className="min-w-0">
                <h5 className="truncate pr-16 text-sm font-bold text-[#10231C]">{product.name}</h5>
                <p className={`text-xs font-semibold ${product.aiReadiness !== 'ready' ? 'text-[#F59E0B]' : 'text-[#5B6F66]'}`}>
                  {product.aiReadiness !== 'ready' && <AlertTriangle className="mr-1 inline h-3.5 w-3.5" />}
                  {product.aiReadiness !== 'ready' ? readiness.label : itemTypeLabels[product.itemType]}
                </p>
              </div>
            </div>
            <p className="line-clamp-2 min-h-[40px] text-sm leading-5 text-[#5B6F66]">
              {product.description || product.aiDescription || 'Sin descripcion visible para el equipo.'}
            </p>
            <div className="mt-3 flex items-end justify-between border-t border-[#D9E5DF] pt-3">
              <p className={`text-xl font-bold ${product.status === 'active' ? 'text-[#128C7E]' : 'text-[#5B6F66]'}`}>{formatPrice(product)}</p>
              <div className="flex flex-col items-end">
                <span className={`mb-1 flex items-center gap-1 text-xs font-semibold ${tone.className}`}>
                  {tone.icon || <span className={`h-2 w-2 rounded-full ${tone.dot}`} />}
                  {tone.text}
                </span>
                <div className="flex flex-wrap justify-end gap-1">
                  {renderCatalogBadges(product)}
                  {renderSectionBadge(product)}
                </div>
              </div>
            </div>
            {renderProductActions(product)}
          </article>
        );
      })}
    </div>
  );

  const renderTable = () => (
    <div className="overflow-x-auto rounded-xl border border-[#D9E5DF] bg-white">
      <table className="min-w-full text-sm">
        <thead className="bg-[#EEF4F1] text-left text-xs font-semibold uppercase text-[#5B6F66]">
          <tr>
            <th className="px-4 py-3">Oferta</th>
            <th className="px-4 py-3">Catalogo</th>
            <th className="px-4 py-3">Seccion</th>
            <th className="px-4 py-3">Disponibilidad</th>
            <th className="px-4 py-3">IA</th>
            <th className="px-4 py-3">Precio</th>
            <th className="px-4 py-3 text-right">Acciones</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-[#D9E5DF]">
          {products.map((product) => {
            const readiness = productReadiness(product);
            return (
              <tr key={product.id}>
                <td className="px-4 py-4">
                  <div className="flex min-w-[220px] items-center gap-3">
                    {renderProductThumb(product, 'h-10 w-10')}
                    <div>
                      <p className="font-bold text-[#10231C]">{product.name}</p>
                      <p className="text-xs text-[#5B6F66]">{itemTypeLabels[product.itemType]}</p>
                    </div>
                  </div>
                </td>
                <td className="px-4 py-4">{renderCatalogBadges(product)}</td>
                <td className="px-4 py-4">{renderSectionBadge(product)}</td>
                <td className="px-4 py-4 text-[#5B6F66]">{availabilitySummary(product)}</td>
                <td className="px-4 py-4">
                  <button type="button" onClick={() => handleToggleAi(product)} className={`admin-badge ${readiness.className}`}>
                    {readiness.label}
                  </button>
                </td>
                <td className="px-4 py-4 font-bold text-[#128C7E]">{formatPrice(product)}</td>
                <td className="px-4 py-4">
                  <div className="flex justify-end gap-2">
                    <button type="button" onClick={() => handleEdit(product)} className="admin-button-secondary h-9 px-3">
                      <Edit2 className="h-4 w-4" />
                    </button>
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );

  return (
    <main className="flex h-[calc(100vh-96px)] flex-col gap-4 overflow-hidden bg-[#F7FAF8] p-4 text-[#10231C] lg:flex-row">
      <section className="admin-scrollbar h-full w-full overflow-y-auto pr-1 lg:w-5/12">
        <div className="mb-4 flex items-center justify-between">
          <div>
            <h3 className="text-xl font-bold text-[#10231C]">{editingId ? 'Editar oferta' : 'Nuevo producto'}</h3>
            <p className="text-sm text-[#5B6F66]">Catalogo comercial conectado a WhatsApp e IA.</p>
          </div>
          <div className="flex items-center gap-2">
            <button type="button" onClick={refreshAll} className="admin-icon-button" aria-label="Actualizar">
              <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
            </button>
            {editingId && (
              <button type="button" onClick={resetForm} className="admin-icon-button text-[#DC2626]" aria-label="Cancelar edicion">
                <X className="h-4 w-4" />
              </button>
            )}
          </div>
        </div>

        {error && (
          <div className="mb-4 rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
            {error}
          </div>
        )}

        <div className="space-y-4 pb-8">
          {renderStepper()}

          {formStep === 1 && (
          <StepCard step={1} title="Catalogo y oferta" footer={(
            <div className="mt-6 flex justify-end">
              <button type="button" disabled={!canContinueStep1} onClick={() => setFormStep(2)} className="admin-button-primary">
                Continuar
                <ArrowRight className="h-4 w-4" />
              </button>
            </div>
          )}>
            <Field label="Nombre del producto / Servicio *">
              <input className="admin-control" placeholder="Ej. Sesion de consultoria, Producto X" value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} />
            </Field>
            <div>
              <p className="mb-1 text-xs font-semibold text-[#5B6F66]">Galeria de producto</p>
              <div className="space-y-3 rounded-xl border border-[#D9E5DF] bg-white p-3">
                <div className="grid gap-3 sm:grid-cols-[112px_1fr]">
                  <div className="flex aspect-square items-center justify-center overflow-hidden rounded-xl border border-[#D9E5DF] bg-[#EEF4F1] text-[#5B6F66]">
                    {form.imageUrl ? (
                      <img src={resolveProductImage(form.imageUrl)} alt={form.name || 'Producto'} className="h-full w-full object-cover" />
                    ) : (
                      <ImageIcon className="h-7 w-7" />
                    )}
                  </div>
                  <div className="space-y-2">
                    <div className="flex flex-col gap-2 sm:flex-row">
                      <button
                        type="button"
                        className="admin-button-secondary disabled:opacity-60"
                        disabled={uploadingImage || form.images.length >= 8}
                        onClick={() => imageInput.current?.click()}
                      >
                        <ImageIcon className="h-4 w-4" aria-hidden="true" />
                        {uploadingImage ? 'Subiendo...' : 'Subir imagen'}
                      </button>
                      <input
                        ref={imageInput}
                        type="file"
                        accept="image/jpeg,image/png,image/webp,image/gif"
                        className="hidden"
                        disabled={uploadingImage || form.images.length >= 8}
                        onChange={(event) => {
                          const file = event.target.files?.[0] || null;
                          handleImageUpload(file);
                          event.currentTarget.value = '';
                        }}
                      />
                      {form.images.length > 0 && (
                        <span className="inline-flex h-10 items-center rounded-lg bg-[#EEF4F1] px-3 text-xs font-semibold text-[#5B6F66]">
                          {form.images.length}/8 imagenes
                        </span>
                      )}
                    </div>
                    <input
                      className="admin-control"
                      placeholder="URL externa opcional"
                      value={form.imageUrl}
                      onChange={(event) => {
                        const imageUrl = event.target.value;
                        setForm((current) => ({
                          ...current,
                          imageUrl,
                          images: imageUrl && current.images.length === 0
                            ? [{ url: imageUrl, altText: current.name || null, isPrimary: true, sortOrder: 0 }]
                            : current.images,
                        }));
                      }}
                    />
                  </div>
                </div>
                {form.images.length > 0 ? (
                  <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                    {form.images.map((image, index) => (
                      <div key={`${image.url}-${index}`} className={`rounded-lg border p-2 ${image.isPrimary ? 'border-[#128C7E] bg-[#DDF4EF]' : 'border-[#D9E5DF] bg-[#F7FAF8]'}`}>
                        <div className="mb-2 aspect-square overflow-hidden rounded-md bg-[#EEF4F1]">
                          <img src={resolveProductImage(image.url)} alt={image.altText || form.name || 'Imagen'} className="h-full w-full object-cover" />
                        </div>
                        <div className="flex items-center justify-between gap-1">
                          <button type="button" className="rounded px-2 py-1 text-[11px] font-bold text-[#128C7E] hover:bg-white" onClick={() => setPrimaryFormImage(index)}>
                            {image.isPrimary ? 'Principal' : 'Usar'}
                          </button>
                          <div className="flex gap-1">
                            <button type="button" className="admin-icon-button h-7 w-7" disabled={index === 0} onClick={() => moveFormImage(index, -1)} aria-label="Mover imagen antes">
                              <ArrowLeft className="h-3.5 w-3.5" />
                            </button>
                            <button type="button" className="admin-icon-button h-7 w-7" disabled={index === form.images.length - 1} onClick={() => moveFormImage(index, 1)} aria-label="Mover imagen despues">
                              <ArrowRight className="h-3.5 w-3.5" />
                            </button>
                            <button type="button" className="admin-icon-button h-7 w-7 text-[#DC2626]" onClick={() => removeFormImage(index)} aria-label="Quitar imagen">
                              <X className="h-3.5 w-3.5" />
                            </button>
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="rounded-lg border border-dashed border-[#D9E5DF] bg-[#F7FAF8] px-3 py-2 text-xs text-[#5B6F66]">
                    Puedes guardar borrador sin imagen. Para publicar, agrega una foto principal.
                  </div>
                )}
              </div>
            </div>
            <div className="grid grid-cols-2 gap-4">
              <Field label="Tipo de precio">
                <SelectWrap>
                  <select className="admin-select" value={form.priceMode} onChange={(event) => setForm({ ...form, priceMode: event.target.value as Product['priceMode'], price: event.target.value === 'free' || event.target.value === 'consult' ? '' : form.price })}>
                    <option value="fixed">Precio fijo</option>
                    <option value="from">Desde</option>
                    <option value="free">Gratis</option>
                    <option value="consult">Consultar</option>
                  </select>
                </SelectWrap>
              </Field>
              <Field label="Precio base">
                <div className="relative">
                  <span className="absolute left-3 top-1/2 -translate-y-1/2 text-[#5B6F66]">$</span>
                  <input className="admin-control pl-8" placeholder="0.00" type="number" min="0" step="0.01" value={form.price} disabled={form.priceMode === 'free' || form.priceMode === 'consult'} onChange={(event) => setForm({ ...form, price: event.target.value })} />
                </div>
              </Field>
            </div>
            <div className="grid grid-cols-2 gap-4">
              <Field label="Tipo de item">
                <SelectWrap>
                  <select className="admin-select" value={form.itemType} onChange={(event) => handleTypeChange(event.target.value as CommercialItemType)}>
                    {Object.entries(itemTypeLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
                  </select>
                </SelectWrap>
              </Field>
            </div>
            <Field label="Asignar a catalogo">
              <div className="flex flex-wrap gap-2 rounded-lg border border-[#D9E5DF] bg-white p-2">
                {catalogs.length === 0 ? (
                  <div className="flex w-full flex-wrap items-center justify-between gap-2 px-2 py-1">
                    <span className="text-sm text-[#5B6F66]">Crea un catalogo para asociar ofertas.</span>
                    <Link to="/dashboard/catalogos" className="admin-button-secondary h-9 px-3 text-xs">
                      Crear catalogo
                    </Link>
                  </div>
                ) : catalogs.map((catalog) => {
                  const selected = form.catalogAssignments.some((item) => item.catalogId === catalog.id);
                  return (
                    <button key={catalog.id} type="button" onClick={() => toggleFormCatalog(catalog.id)} className={`rounded-full px-3 py-1.5 text-xs font-bold transition ${selected ? 'bg-[#128C7E] text-white' : 'bg-[#EEF4F1] text-[#5B6F66] hover:text-[#128C7E]'}`}>
                      {catalog.name}
                    </button>
                  );
                })}
              </div>
            </Field>
            {form.catalogAssignments.length > 0 && (
              <div className="space-y-2 rounded-xl border border-[#D9E5DF] bg-[#F7FAF8] p-3">
                <p className="text-xs font-bold uppercase text-[#5B6F66]">Secciones por catalogo</p>
                {form.catalogAssignments.map((assignment) => {
                  const catalog = catalogs.find((item) => item.id === assignment.catalogId);
                  return (
                    <div key={assignment.catalogId} className="grid gap-2 sm:grid-cols-[130px_1fr] sm:items-center">
                      <span className="truncate text-sm font-semibold text-[#10231C]">{catalog?.name || 'Catalogo'}</span>
                      <SelectWrap>
                        <select className="admin-select" value={assignment.sectionId || ''} onChange={(event) => setAssignmentSection(assignment.catalogId, event.target.value ? Number(event.target.value) : null)}>
                          <option value="">Sin seccion</option>
                          {(catalog?.sections || []).map((section) => (
                            <option key={section.id} value={section.id}>{section.name}</option>
                          ))}
                        </select>
                      </SelectWrap>
                    </div>
                  );
                })}
              </div>
            )}
            <div className="grid grid-cols-2 gap-4">
              <Field label="Unidad">
                <input className="admin-control" placeholder="unidad" value={form.unitLabel} onChange={(event) => setForm({ ...form, unitLabel: event.target.value })} />
              </Field>
              <Field label="SKU / Codigo">
                <input className="admin-control" placeholder="SKU-001" value={form.sku} onChange={(event) => setForm({ ...form, sku: event.target.value })} />
              </Field>
            </div>
          </StepCard>
          )}

          {formStep === 2 && (
          <StepCard step={2} title="Disponibilidad y venta" footer={(
            <div className="mt-6 flex justify-between gap-3">
              <button type="button" onClick={() => setFormStep(1)} className="admin-button-secondary">
                <ArrowLeft className="h-4 w-4" />
                Anterior
              </button>
              <button type="button" disabled={!canContinueStep2} onClick={() => setFormStep(3)} className="admin-button-primary">
                Continuar
                <ArrowRight className="h-4 w-4" />
              </button>
            </div>
          )}>
            <div className="grid grid-cols-2 gap-4">
              {editingId && <Field label="Estado">
                <SelectWrap>
                  <select className="admin-select" value={form.status} onChange={(event) => setForm({ ...form, status: event.target.value as Product['status'] })}>
                    <option value="active">Activo</option>
                    <option value="draft">Borrador</option>
                    <option value="inactive">Inactivo</option>
                    <option value="archived">Archivado</option>
                  </select>
                </SelectWrap>
              </Field>}
              <Field label="Control de stock">
                <SelectWrap>
                  <select className="admin-select" value={form.availabilityType} onChange={(event) => setForm({ ...form, availabilityType: event.target.value as AvailabilityType })}>
                    {Object.entries(availabilityLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
                  </select>
                </SelectWrap>
              </Field>
            </div>
            <p className="rounded-lg bg-[#EEF4F1] px-3 py-2 text-xs text-[#5B6F66]">{availabilityHelp[form.availabilityType]}</p>
            <div className="grid grid-cols-2 gap-4">
              <Field label="Unidades / Cupos">
                <input className="admin-control" type="number" min="0" step="1" value={form.stockAvailable} disabled={!usesQuantity} onChange={(event) => setForm({ ...form, stockAvailable: event.target.value })} />
              </Field>
              <Field label="Reserva minima">
                <input className="admin-control" type="number" min="1" step="1" placeholder="1" value={form.reservationTtlMinutes} onChange={(event) => setForm({ ...form, reservationTtlMinutes: event.target.value })} />
              </Field>
            </div>
            <Field label="Capacidad total">
              <input className="admin-control" type="number" min="0" step="1" value={form.capacity} disabled={form.availabilityType !== 'capacity'} onChange={(event) => setForm({ ...form, capacity: event.target.value })} />
            </Field>
            <label className="flex cursor-pointer items-center gap-3 rounded-lg border border-[#D9E5DF] bg-white p-3 transition-colors hover:bg-[#EEF4F1]">
              <input className="h-5 w-5 rounded border-[#5B6F66] accent-[#128C7E]" type="checkbox" checked={form.requiresHumanApproval} onChange={(event) => setForm({ ...form, requiresHumanApproval: event.target.checked })} />
              <span className="text-sm text-[#10231C]">Requiere aprobacion humana antes del pago</span>
            </label>
          </StepCard>
          )}

          {formStep === 3 && (
          <StepCard step={3} title="IA y publicacion" ai icon={<Bot className="h-4 w-4 text-[#128C7E]" />} footer={(
            <div className="mt-6 flex flex-col gap-3 sm:flex-row">
              <button type="button" onClick={() => setFormStep(2)} className="admin-button-secondary sm:w-auto">
                <ArrowLeft className="h-4 w-4" />
                Anterior
              </button>
              <button type="button" disabled={saving} onClick={() => saveProduct('draft')} className="flex-1 rounded-lg border border-[#D9E5DF] px-4 py-2 text-sm font-semibold text-[#10231C] transition hover:bg-[#EEF4F1] disabled:opacity-60">
                Guardar borrador
              </button>
              <button type="button" disabled={saving} onClick={() => saveProduct(editingId ? undefined : 'active')} className="flex-1 rounded-lg bg-[#128C7E] px-4 py-2 text-sm font-semibold text-white shadow-sm transition hover:bg-[#0E766A] disabled:opacity-60">
                {saving ? 'Guardando...' : editingId ? 'Guardar cambios' : 'Publicar oferta'}
              </button>
            </div>
          )}>
            <div className="flex items-center justify-between rounded-lg bg-[#EEF4F1] p-4">
              <div>
                <p className="text-sm font-bold text-[#10231C]">Habilitar IA para este producto</p>
                <p className="text-xs text-[#5B6F66]">Permite al agente ofrecer y responder dudas.</p>
              </div>
              <label className="relative inline-flex cursor-pointer items-center">
                <input className="peer sr-only" type="checkbox" checked={form.aiEnabled} onChange={(event) => setForm({ ...form, aiEnabled: event.target.checked })} />
                <span className="h-6 w-11 rounded-full bg-[#EEF4F1] after:absolute after:left-[2px] after:top-[2px] after:h-5 after:w-5 after:rounded-full after:border after:border-[#D9E5DF] after:bg-white after:transition-all peer-checked:bg-[#128C7E] peer-checked:after:translate-x-full" />
              </label>
            </div>
            <Field label="Descripcion detallada (Para el cliente y la IA)">
              <textarea className="admin-textarea min-h-[92px] resize-y" placeholder="Describe el producto. La IA usara esta info para responder preguntas..." value={form.aiDescription} onChange={(event) => setForm({ ...form, aiDescription: event.target.value })} />
            </Field>
            <Field label="Instrucciones ocultas de venta (Prompt para IA)">
              <textarea className="admin-textarea min-h-[72px] resize-y bg-[#EEF4F1] italic text-[#5B6F66]" placeholder="Ej: No ofrezcas descuentos salvo que el cliente pregunte por planes grupales..." value={form.aiSalesInstructions} onChange={(event) => setForm({ ...form, aiSalesInstructions: event.target.value })} />
            </Field>
          </StepCard>
          )}

        </div>
      </section>

      <section className="flex h-full w-full flex-col overflow-hidden rounded-2xl border border-[#D9E5DF] bg-white shadow-sm lg:w-7/12">
        <div className="border-b border-[#D9E5DF] bg-white p-5">
          <h3 className="mb-4 text-xl font-bold text-[#10231C]">Ofertas registradas</h3>
          <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
            <div className="rounded-xl border border-[#D9E5DF] bg-[#EEF4F1] p-3">
              <p className="text-xs font-semibold text-[#5B6F66]">Total</p>
              <p className="text-2xl font-bold text-[#10231C]">{summary.total}</p>
            </div>
            <div className="rounded-xl border border-[#25D366]/40 bg-[#E4FBEF] p-3">
              <p className="flex items-center gap-1 text-xs font-semibold text-[#5B6F66]"><Bot className="h-3.5 w-3.5 text-[#128C7E]" /> Activos IA</p>
              <p className="text-2xl font-bold text-[#128C7E]">{summary.aiEnabled}</p>
            </div>
            <div className="rounded-xl border border-[#FFDAD6] bg-[#FFDAD6]/30 p-3">
              <p className="text-xs font-semibold text-[#BA1A1A]">Necesitan info</p>
              <p className="text-2xl font-bold text-[#93000A]">{summary.needsInfo}</p>
            </div>
            <div className="rounded-xl border border-[#D9E5DF] bg-[#EEF4F1] p-3">
              <p className="text-xs font-semibold text-[#5B6F66]">Sin catalogo</p>
              <p className="text-2xl font-bold text-[#5B6F66]">{summary.withoutCatalog}</p>
            </div>
          </div>
        </div>

        <div className="flex flex-wrap items-center justify-between gap-4 border-b border-[#D9E5DF] bg-white p-4">
          <div className="flex min-w-[220px] flex-1 items-center gap-2">
            <div className="relative flex-1">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-5 w-5 -translate-y-1/2 text-[#5B6F66]" />
              <input className="h-10 w-full rounded-lg border border-[#D9E5DF] bg-[#EEF4F1] pl-10 pr-3 text-sm text-[#10231C] outline-none transition focus:border-[#128C7E] focus:ring-2 focus:ring-[#128C7E]/15" placeholder="Buscar por nombre o ID..." value={searchTerm} onChange={(event) => setSearchTerm(event.target.value)} />
            </div>
            <button type="button" aria-label="Filtros" onClick={() => setShowFilters((value) => !value)} className="flex items-center gap-1 rounded-lg border border-[#D9E5DF] px-2 py-2 text-[#5B6F66] transition hover:bg-[#EEF4F1]">
              <SlidersHorizontal className="h-4 w-4" />
              <span className="hidden text-xs font-semibold sm:inline">Filtros</span>
            </button>
          </div>
          <div className="flex items-center gap-2 rounded-lg border border-[#D9E5DF] bg-[#EEF4F1] p-1">
            <button type="button" onClick={() => setViewMode('cards')} className={`rounded p-1 transition ${viewMode === 'cards' ? 'bg-white text-[#128C7E] shadow-sm' : 'text-[#5B6F66] hover:text-[#128C7E]'}`} aria-label="Vista tarjetas">
              <Grid2X2 className="h-5 w-5" />
            </button>
            <button type="button" onClick={() => setViewMode('table')} className={`rounded p-1 transition ${viewMode === 'table' ? 'bg-white text-[#128C7E] shadow-sm' : 'text-[#5B6F66] hover:text-[#128C7E]'}`} aria-label="Vista tabla">
              <List className="h-5 w-5" />
            </button>
          </div>
          {showFilters && (
            <div className="grid w-full gap-2 md:grid-cols-4">
              <SelectWrap>
                <select className="admin-select" value={typeFilter} onChange={(event) => setTypeFilter(event.target.value as 'all' | CommercialItemType)}>
                  <option value="all">Todos los tipos</option>
                  {Object.entries(itemTypeLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
                </select>
              </SelectWrap>
              <SelectWrap>
                <select className="admin-select" value={statusFilter} onChange={(event) => setStatusFilter(event.target.value as 'all' | Product['status'])}>
                  <option value="all">Todos los estados</option>
                  <option value="draft">Borrador</option>
                  <option value="active">Activo</option>
                  <option value="inactive">Inactivo</option>
                  <option value="archived">Archivado</option>
                </select>
              </SelectWrap>
              <SelectWrap>
                <select className="admin-select" value={selectedSectionId} onChange={(event) => setSelectedSectionId(event.target.value === 'all' ? 'all' : Number(event.target.value))}>
                  <option value="all">Todas las secciones</option>
                  {visibleSections.map((section) => <option key={section.id} value={section.id}>{section.name}</option>)}
                </select>
              </SelectWrap>
              <SelectWrap>
                <select className="admin-select" value={aiFilter} onChange={(event) => setAiFilter(event.target.value as AiFilter)}>
                  <option value="all">Toda IA</option>
                  <option value="enabled">IA activa</option>
                  <option value="disabled">IA apagada</option>
                </select>
              </SelectWrap>
            </div>
          )}
        </div>

        <div className="admin-scrollbar flex-1 overflow-y-auto bg-[#F7FAF8] p-4">
          {products.length === 0 ? (
            <div className="flex min-h-[320px] flex-col items-center justify-center rounded-xl border border-dashed border-[#D9E5DF] bg-white px-6 text-center text-[#5B6F66]">
              <Package className="mb-3 h-10 w-10 text-[#128C7E]" />
              <p className="text-sm font-bold text-[#10231C]">No hay ofertas para mostrar</p>
              <p className="mt-1 max-w-sm text-sm">Crea una oferta o limpia los filtros para ver el catalogo completo.</p>
            </div>
          ) : viewMode === 'cards' ? renderCards() : renderTable()}
        </div>
      </section>
    </main>
  );
};

export default InventoryPage;
