import axios from 'axios';

class DiscordService {
  private webhookUrl: string;
  private alertsEnabled: boolean;

  constructor(webhookUrl: string, alertsEnabled: boolean) {
    this.webhookUrl = webhookUrl;
    this.alertsEnabled = alertsEnabled;
  }

  async sendAlert(heading: string, message: string): Promise<void> {
    if (!this.alertsEnabled) {
      console.log('Alerts are disabled.');
      return;
    }

    const alertPayload = {
      embeds: [
        {
          title: heading,
          description: message,
          color: 16711680, // Optional: Red color for the alert embed
        },
      ],
    };

    try {
      await axios.post(this.webhookUrl, alertPayload, {
        headers: {
          'Content-Type': 'application/json',
        },
      });
      console.log('Alert sent successfully.');
    } catch (error) {
      console.error('Failed to send alert:', error);
    }
  }
}


export default DiscordService;
