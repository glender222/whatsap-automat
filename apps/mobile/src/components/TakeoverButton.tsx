import React, { useState } from 'react';
import { ActivityIndicator, Modal, Pressable, StyleSheet, Text, View } from 'react-native';
import { apiClient, MobileApiError, type MobileConversation } from '../services/apiClient';
import { DARK_THEME as colors } from '../types/navigation';

export function TakeoverButton({
  chat,
  userId,
  onUpdated,
  onConflict,
  onNotice,
}: {
  chat: MobileConversation;
  userId: string;
  onUpdated: (state: Partial<MobileConversation>) => void;
  onConflict: (error: MobileApiError) => Promise<void>;
  onNotice: (message: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const { conversationId, stateVersion, assignedUserId, aiPaused } = chat;

  if (conversationId == null || stateVersion == null) return null;
  if (String(assignedUserId) === userId && aiPaused) {
    return <Text style={styles.status}>A tu cargo</Text>;
  }

  async function takeover() {
    if (busy || conversationId == null || stateVersion == null) return;
    setConfirming(false);
    setBusy(true);
    onNotice('');
    try {
      const result = await apiClient.takeoverConversation(conversationId, stateVersion);
      onUpdated({
        stateVersion: result.newVersion,
        assignedUserId: result.ownerId,
        aiPaused: result.aiPaused,
      });
    } catch (error) {
      if (error instanceof MobileApiError && error.status === 409) {
        await onConflict(error);
        onNotice('La conversación cambió. Revisa quién tiene el control antes de volver a intentarlo.');
      } else {
        onNotice('No se pudo tomar la conversación. Revisa tu conexión y vuelve a intentar.');
      }
    } finally {
      setBusy(false);
    }
  }

  function confirm() {
    if (assignedUserId != null && String(assignedUserId) !== userId) {
      setConfirming(true);
      return;
    }
    void takeover();
  }

  return (
    <>
      <Pressable accessibilityRole="button" accessibilityState={{ busy, disabled: busy }} disabled={busy} style={styles.button} onPress={confirm}>
        {busy ? <ActivityIndicator color={colors.textPrimary} /> : <Text style={styles.label}>Tomar control</Text>}
      </Pressable>
      <Modal visible={confirming} transparent animationType="fade" onRequestClose={() => setConfirming(false)}>
        <View style={styles.overlay}>
          <View style={styles.dialog} accessibilityViewIsModal>
            <Text accessibilityRole="header" style={styles.dialogTitle}>Reasignar conversación</Text>
            <Text style={styles.dialogCopy}>La conversación está asignada a otra persona. Si tomas el control, quedará a tu cargo.</Text>
            <View style={styles.actions}>
              <Pressable accessibilityRole="button" style={[styles.button, styles.cancel]} onPress={() => setConfirming(false)}>
                <Text style={styles.label}>Cancelar</Text>
              </Pressable>
              <Pressable accessibilityRole="button" style={styles.button} onPress={() => void takeover()}>
                <Text style={styles.label}>Confirmar</Text>
              </Pressable>
            </View>
          </View>
        </View>
      </Modal>
    </>
  );
}

const styles = StyleSheet.create({
  button: { minHeight: 44, justifyContent: 'center', paddingHorizontal: 12, borderRadius: 10, backgroundColor: colors.primaryHover },
  label: { color: colors.textPrimary, fontSize: 13, fontWeight: '700' },
  status: { color: colors.accent, fontSize: 13, fontWeight: '700' },
  overlay: { flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: 'rgba(0,0,0,0.65)', padding: 22 },
  dialog: { width: '100%', maxWidth: 420, borderRadius: 14, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surface, padding: 20, gap: 12 },
  dialogTitle: { color: colors.textPrimary, fontSize: 19, fontWeight: '700' },
  dialogCopy: { color: colors.textSecondary, fontSize: 15, lineHeight: 22 },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: 10, justifyContent: 'flex-end' },
  cancel: { backgroundColor: colors.surfaceLight },
});
