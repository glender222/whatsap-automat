/**
 * CAS Human Takeover Component for Mobile
 * Executes Compare-And-Swap takeover passing expectedVersion.
 * Catches RFC 7807 409 Conflict on stale state and reloads fresh conversation.
 */

import React, { useState } from 'react';
import {
  TouchableOpacity,
  Text,
  ActivityIndicator,
  Alert,
  StyleSheet,
  ViewStyle,
} from 'react-native';
import { UserCheck, ShieldAlert, AlertTriangle } from 'lucide-react-native';
import { ConflictError } from '@whatsap-automat/sdk';
import { apiClient } from '../services/apiClient';
import { DARK_THEME } from '../types/navigation';

export interface TakeoverButtonProps {
  conversationId: string;
  expectedVersion: number;
  activeUserId: string;
  assignedUserId?: string | null;
  aiPaused?: boolean;
  onTakeoverSuccess?: (result: any) => void;
  onConflict?: (error: ConflictError) => void;
  onReloadRequested?: () => Promise<void>;
  disabled?: boolean;
  style?: ViewStyle;
}

export const TakeoverButton: React.FC<TakeoverButtonProps> = ({
  conversationId,
  expectedVersion,
  activeUserId,
  assignedUserId,
  aiPaused = false,
  onTakeoverSuccess,
  onConflict,
  onReloadRequested,
  disabled = false,
  style,
}) => {
  const [isLoading, setIsLoading] = useState(false);

  const isAssignedToMe = assignedUserId === activeUserId;
  const isHumanTaken = Boolean(assignedUserId) || aiPaused;

  const handleTakeoverPress = async () => {
    if (isLoading || disabled) return;

    // Confirm dialog if already taken over by another agent
    if (assignedUserId && assignedUserId !== activeUserId) {
      Alert.alert(
        'Reassign Conversation',
        `This conversation is currently assigned to Operator ${assignedUserId}. Do you want to take over?`,
        [
          { text: 'Cancel', style: 'cancel' },
          { text: 'Take Over', style: 'destructive', onPress: executeTakeover },
        ]
      );
      return;
    }

    await executeTakeover();
  };

  const executeTakeover = async () => {
    setIsLoading(true);
    try {
      const result = await apiClient.takeoverConversation(conversationId, {
        expectedVersion,
        userId: activeUserId,
        reason: 'Mobile operator manual takeover',
      });

      onTakeoverSuccess?.(result);
    } catch (err: any) {
      if (err instanceof ConflictError || err?.status === 409) {
        const conflictErr = err as ConflictError;
        const currentVersion =
          (conflictErr.metadata as any)?.currentVersion ?? expectedVersion + 1;

        // Display user-friendly CAS conflict alert
        Alert.alert(
          'Version Conflict (CAS 409)',
          `The conversation was modified concurrently by another operator or automated AI agent.\n\n` +
            `Expected version: v${expectedVersion}\n` +
            `Current server version: v${currentVersion}\n\n` +
            `Refreshing conversation to display latest messages...`,
          [
            {
              text: 'OK',
              onPress: async () => {
                onConflict?.(conflictErr);
                if (onReloadRequested) {
                  await onReloadRequested();
                }
              },
            },
          ]
        );
      } else {
        // General error alert
        Alert.alert(
          'Takeover Failed',
          err?.message || 'An unexpected error occurred during CAS takeover.'
        );
      }
    } finally {
      setIsLoading(false);
    }
  };

  if (isAssignedToMe) {
    return (
      <TouchableOpacity
        style={[styles.button, styles.buttonAssigned, style]}
        disabled={true}
        accessibilityRole="button"
        accessibilityLabel="Assigned to you"
      >
        <UserCheck size={16} color={DARK_THEME.accent} />
        <Text style={[styles.text, styles.textAssigned]}>Assigned to You</Text>
      </TouchableOpacity>
    );
  }

  return (
    <TouchableOpacity
      style={[
        styles.button,
        isHumanTaken ? styles.buttonReassign : styles.buttonActive,
        disabled && styles.buttonDisabled,
        style,
      ]}
      onPress={handleTakeoverPress}
      disabled={isLoading || disabled}
      accessibilityRole="button"
      accessibilityLabel={`Take control of conversation. Current version ${expectedVersion}`}
    >
      {isLoading ? (
        <ActivityIndicator size="small" color="#ffffff" />
      ) : isHumanTaken ? (
        <>
          <AlertTriangle size={15} color="#ffffff" />
          <Text style={styles.text}>Reassign (v{expectedVersion})</Text>
        </>
      ) : (
        <>
          <ShieldAlert size={15} color="#ffffff" />
          <Text style={styles.text}>Take Control (v{expectedVersion})</Text>
        </>
      )}
    </TouchableOpacity>
  );
};

const styles = StyleSheet.create({
  button: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 8,
    justifyContent: 'center',
  },
  buttonActive: {
    backgroundColor: DARK_THEME.primary, // teal-600
  },
  buttonReassign: {
    backgroundColor: DARK_THEME.warning, // amber-500
  },
  buttonAssigned: {
    backgroundColor: 'rgba(16, 185, 129, 0.15)', // emerald border background
    borderWidth: 1,
    borderColor: DARK_THEME.accent,
  },
  buttonDisabled: {
    opacity: 0.5,
  },
  text: {
    fontSize: 13,
    fontWeight: '600',
    color: '#ffffff',
  },
  textAssigned: {
    color: DARK_THEME.accent,
  },
});
