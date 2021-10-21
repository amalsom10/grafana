import React, { useState } from 'react';
import { Modal, Button, Label, useStyles2, RadioButtonGroup } from '@grafana/ui';
import { GrafanaTheme2 } from '@grafana/data';
import { useForm, FormProvider } from 'react-hook-form';
import { TestReceiversAlert } from 'app/plugins/datasource/alertmanager/types';
import { css } from '@emotion/css';
import AnnotationsField from '../../rule-editor/AnnotationsField';
import LabelsField from '../../rule-editor/LabelsField';

interface Props {
  isOpen: boolean;
  onDismiss: () => void;
  onTest: (alert?: TestReceiversAlert) => void;
}

type AnnoField = {
  key: string;
  value: string;
};

interface FormFields {
  annotations: AnnoField[];
  labels: AnnoField[];
}

enum NotificationType {
  predefined = 'Predefined',
  custom = 'Custom',
}

const notificationOptions = Object.values(NotificationType).map((value) => ({ label: value, value: value }));

const defaultValues: FormFields = {
  annotations: [{ key: '', value: '' }],
  labels: [{ key: '', value: '' }],
};

const reservedAnnotations = ['summary'];

export const TestNotificationChannelModal = ({ isOpen, onDismiss, onTest }: Props) => {
  const [notificationType, setNotificationType] = useState<NotificationType>(NotificationType.predefined);
  const styles = useStyles2(getStyles);
  const formMethods = useForm<FormFields>({ defaultValues, mode: 'onBlur' });

  const onSubmit = (data: FormFields) => {
    if (notificationType === NotificationType.custom) {
      const alert = {
        annotations: data.annotations
          .filter(({ key, value }) => !!key && !!value)
          .reduce((acc, { key, value }) => {
            return { ...acc, [key]: value };
          }, {}),
        labels: data.labels
          .filter(({ key, value }) => !!key && !!value)
          .reduce((acc, { key, value }) => {
            return { ...acc, [key]: value };
          }, {}),
      };
      onTest(alert);
    } else {
      onTest();
    }
  };

  return (
    <Modal onDismiss={onDismiss} isOpen={isOpen} title={'Test contact point'}>
      <div className={styles.section}>
        <Label>Notification message</Label>
        <RadioButtonGroup
          options={notificationOptions}
          value={notificationType}
          onChange={(value) => setNotificationType(value)}
        />
      </div>

      <FormProvider {...formMethods}>
        <form onSubmit={formMethods.handleSubmit(onSubmit)}>
          {notificationType === NotificationType.predefined && (
            <div className={styles.section}>
              You will send a test notification that uses a predefined alert. If you have defined a custom template or
              message, for better results switch to <strong>custom</strong> notification message, from above.
            </div>
          )}
          {notificationType === NotificationType.custom && (
            <>
              <div className={styles.section}>
                You will send a test notification that uses the annotations defined below. This is a good option if you
                use custom templates and messages.
              </div>
              <div className={styles.section}>
                <AnnotationsField reservedKeys={reservedAnnotations} />
              </div>
              <div className={styles.section}>
                <LabelsField />
              </div>
            </>
          )}

          <Modal.ButtonRow>
            <Button type="submit">Send test notification</Button>
          </Modal.ButtonRow>
        </form>
      </FormProvider>
    </Modal>
  );
};

const getStyles = (theme: GrafanaTheme2) => ({
  flexRow: css`
    display: flex;
    flex-direction: row;
    align-items: flex-start;
    margin-bottom: ${theme.spacing(1)};
  `,
  annotationButton: css`
    margin-left: 150px;
  `,
  section: css`
    margin-bottom: ${theme.spacing(2)};
  `,
  inputRow: css`
    display: flex;
    flex-direction: row;
    align-items: flex-start;
    gap: ${theme.spacing(1)};
    margin-bottom: ${theme.spacing(1)};
  `,
  equalSign: css`
    align-self: flex-start;
    width: 28px;
    justify-content: center;
  `,
  annotationTextArea: css`
    min-height: ${theme.spacing(10)};
  `,
});