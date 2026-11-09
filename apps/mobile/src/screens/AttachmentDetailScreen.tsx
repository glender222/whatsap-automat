import React, { useCallback, useRef, useState } from 'react';
import { ActivityIndicator, Platform, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useFocusEffect } from '@react-navigation/native';
import { Image } from 'expo-image';
import { fromByteArray } from 'base64-js';
import ArrowLeft from 'lucide-react-native/icons/arrow-left';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { apiClient, MobileApiError } from '../services/apiClient';
import { isMatchingImage, isPreviewImage, MAX_ATTACHMENT_BYTES, safeAttachmentName } from '../services/attachmentData';
import { saveAttachment } from '../services/attachmentExport';
import { useSession } from '../services/sessionContext';
import { DARK_THEME as colors, type RootStackParamList } from '../types/navigation';

type Props = NativeStackScreenProps<RootStackParamList, 'AttachmentDetail'>;
type Action = 'preview' | 'download';

function Button({ label, onPress, disabled = false }: { label: string; onPress: () => void; disabled?: boolean }) {
  return (
    <Pressable accessibilityRole="button" accessibilityState={{ disabled }} disabled={disabled}
      style={[styles.button, disabled && styles.disabled]} onPress={onPress}>
      <Text style={styles.buttonLabel}>{label}</Text>
    </Pressable>
  );
}

export function AttachmentDetailScreen({ route, navigation }: Props) {
  const { conversationId, messageId, attachment } = route.params;
  const { isSessionActive } = useSession();
  const request = useRef<AbortController | null>(null);
  const previewUrl = useRef<string | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [busy, setBusy] = useState<Action | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const tooLarge = (attachment.sizeBytes ?? 0) > MAX_ATTACHMENT_BYTES;
  const filename = safeAttachmentName(attachment.filename, attachment.mimeType);

  const releasePreview = useCallback(() => {
    if (previewUrl.current && Platform.OS === 'web') URL.revokeObjectURL(previewUrl.current);
    previewUrl.current = null;
    setPreview(null);
  }, []);

  const cancel = useCallback(() => {
    request.current?.abort();
    request.current = null;
    setBusy(null);
  }, []);

  useFocusEffect(useCallback(() => () => {
    cancel();
    releasePreview();
  }, [cancel, releasePreview]));

  async function open(action: Action) {
    if (request.current || tooLarge || !isSessionActive()) return;
    const controller = new AbortController();
    request.current = controller;
    const isActive = () => request.current === controller && !controller.signal.aborted && isSessionActive();
    setBusy(action);
    setError('');
    setNotice('');
    try {
      const file = await apiClient.getConversationAttachment(conversationId, messageId, attachment.id, controller.signal);
      if (!isActive()) return;
      if (action === 'preview') {
        if (!isMatchingImage(file)) {
          setError('El archivo recibido no coincide con un formato de imagen compatible.');
          return;
        }
        releasePreview();
        const uri = Platform.OS === 'web'
          ? URL.createObjectURL(new Blob([file.bytes], { type: file.mimeType }))
          : `data:${file.mimeType};base64,${fromByteArray(file.bytes)}`;
        previewUrl.current = uri;
        setPreview(uri);
      } else {
        const saved = await saveAttachment(file, safeAttachmentName(attachment.filename, file.mimeType), isActive);
        if (saved && isActive()) setNotice(Platform.OS === 'web' ? 'Descarga iniciada.' : 'Archivo guardado en la carpeta elegida.');
      }
    } catch (cause) {
      if (!isActive()) return;
      if (cause instanceof MobileApiError && [403, 404].includes(cause.status)) {
        setError('El adjunto ya no está disponible para esta sesión.');
      } else if (cause instanceof MobileApiError && cause.status === 413) {
        setError('El archivo supera el límite de 10 MB.');
      } else {
        setError('No se pudo abrir o guardar el archivo. Vuelve a intentarlo.');
      }
    } finally {
      if (request.current === controller) {
        request.current = null;
        setBusy(null);
      }
    }
  }

  return (
    <SafeAreaView style={styles.screen}>
      <View style={styles.header}>
        <Pressable accessibilityRole="button" accessibilityLabel="Volver" style={styles.back} onPress={navigation.goBack}>
          <ArrowLeft size={22} color={colors.textPrimary} />
        </Pressable>
        <Text accessibilityRole="header" style={styles.title}>Detalle de adjunto</Text>
      </View>
      <ScrollView contentContainerStyle={styles.content}>
        <Text accessibilityRole="header" style={styles.filename}>{filename}</Text>
        <Text style={styles.secondary}>{attachment.mimeType}</Text>
        {attachment.sizeBytes !== undefined ? <Text style={styles.secondary}>{Math.ceil(attachment.sizeBytes / 1024)} KB</Text> : null}
        {tooLarge ? <Text accessibilityRole="alert" style={styles.error}>El archivo supera el límite de 10 MB.</Text> : null}
        {error ? <Text accessibilityRole="alert" style={styles.error}>{error}</Text> : null}
        {notice ? <Text accessibilityLiveRegion="polite" style={styles.secondary}>{notice}</Text> : null}
        {preview ? (
          <>
            <Image source={preview} cachePolicy="none" contentFit="contain" autoplay={false} accessible
              accessibilityLabel={`Vista previa de ${filename}`} style={styles.preview}
              onError={() => { releasePreview(); setError('No se pudo mostrar la imagen.'); }} />
            <Button label="Cerrar vista previa" onPress={releasePreview} />
          </>
        ) : isPreviewImage(attachment.mimeType) ? (
          <Button label="Ver imagen" disabled={tooLarge || !!busy} onPress={() => void open('preview')} />
        ) : null}
        <Button label="Descargar archivo" disabled={tooLarge || !!busy} onPress={() => void open('download')} />
        {busy ? (
          <View style={styles.progress}>
            <ActivityIndicator color={colors.accent} accessibilityLabel="Cargando archivo" />
            <Button label="Cancelar" onPress={cancel} />
          </View>
        ) : null}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.background },
  header: { flexDirection: 'row', alignItems: 'center', gap: 12, padding: 12, borderBottomWidth: 1, borderColor: colors.border },
  back: { width: 44, height: 44, borderRadius: 10, backgroundColor: colors.surface, alignItems: 'center', justifyContent: 'center' },
  title: { color: colors.textPrimary, fontSize: 20, fontWeight: '800' },
  content: { gap: 12, padding: 16, paddingBottom: 28 },
  filename: { color: colors.textPrimary, fontSize: 16, fontWeight: '700' },
  secondary: { color: colors.textSecondary, fontSize: 14 },
  error: { color: colors.danger, fontSize: 14 },
  preview: { width: '100%', height: 300, borderRadius: 10, backgroundColor: colors.surface },
  progress: { flexDirection: 'row', gap: 12, alignItems: 'center' },
  button: { minHeight: 44, justifyContent: 'center', paddingHorizontal: 12, borderRadius: 10, backgroundColor: colors.surfaceLight },
  buttonLabel: { color: colors.accent, fontSize: 14, fontWeight: '700' },
  disabled: { opacity: 0.5 },
});
